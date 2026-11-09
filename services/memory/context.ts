import { promises as fs } from 'node:fs';
import path from 'node:path';
import { glob } from 'tinyglobby';
import { FSWatcher, watch } from 'node:fs';
import type { MemoryStorage, MemoryChunk } from './types.js';
import { createLogger } from '../../lib/logger.js';
import { toMessage } from '../../lib/error.js';
import { generateEmbedding, cosineSimilarity, textScore, embeddingIdentity } from './embedding.js';
import type { EmbeddingConfig } from './embedding.js';
import { createChunks } from './chunker.js';
import { indexSessions } from './session-indexer.js';

export type { MemoryChunk };

const log = createLogger('memory');

export interface ContextSearchResult {
  chunk:    MemoryChunk;
  score:    number;
  citation: string;
}

export interface MemoryContextConfig {
  memoryDir:         string;
  cacheDir:          string;
  sessionsDir?:      string;
  chunkSize?:        number;
  chunkOverlap?:     number;
  embeddingProvider?: 'openai' | 'ollama' | 'local' | 'none';
  openaiApiKey?:     string;
  embeddingModel?:   string;
  embeddingBaseUrl?: string;
  hybridWeight?:     { vector: number; text: number };
  storage?:          MemoryStorage;
  enableFileWatcher?: boolean;
}

export class MemoryContext {
  private readonly chunkSize:        number;
  private readonly chunkOverlap:     number;
  private readonly embeddingProvider: 'openai' | 'ollama' | 'local' | 'none';
  private readonly hybridWeight:     { vector: number; text: number };
  private readonly enableFileWatcher: boolean;
  private readonly embeddingConfig:  EmbeddingConfig;
  private readonly identity: string;
  private chunks: Map<string, MemoryChunk> = new Map();
  private lastSync = 0;
  private storage: MemoryStorage | null    = null;
  private fileWatcher: FSWatcher | null    = null;
  private watcherDebounce = new Map<string, NodeJS.Timeout>();

  constructor(private readonly config: MemoryContextConfig) {
    this.chunkSize         = config.chunkSize        ?? 400;  // target token count per chunk
    this.chunkOverlap      = config.chunkOverlap     ?? 80;   // overlapping tokens between chunks
    this.embeddingProvider = config.embeddingProvider ?? 'none';
    this.hybridWeight      = config.hybridWeight     ?? { vector: 0.7, text: 0.3 };
    this.enableFileWatcher = config.enableFileWatcher ?? false;
    this.embeddingConfig   = {
      provider:     this.embeddingProvider,
      openaiApiKey: config.openaiApiKey,
      model:        config.embeddingModel,
      baseUrl:      config.embeddingBaseUrl,
    };
    this.identity = embeddingIdentity(this.embeddingConfig);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.config.cacheDir, { recursive: true });

    let rebuild = false;
    if (this.config.storage) {
      this.storage = this.config.storage;
      await this.storage.initialize();
      const stored = await this.storage.getAllChunks();
      rebuild = stored.some(chunk => chunk.metadata.embeddingIdentity !== this.identity);
      if (rebuild) {
        log.info('embedding configuration changed or index is unversioned; rebuilding derived memory index');
        await this.storage.clear();
      } else {
        for (const chunk of stored) this.chunks.set(chunk.id, chunk);
      }
    }

    await this.sync({ reason: 'init', force: rebuild });

    if (this.enableFileWatcher) this.startFileWatcher();
  }

  async close(): Promise<void> {
    this.stopFileWatcher();
      if (this.storage) {
      await this.storage.close();
      this.storage = null;
    }
  }

  // ── Indexing ───────────────────────────────────────────────────────────────

  async sync(options?: { reason?: string; force?: boolean }): Promise<void> {
    const currentTimestampMs = Date.now();
    if (!options?.force && currentTimestampMs - this.lastSync < 5_000) return;

    const files = await glob('**/*.md', { cwd: this.config.memoryDir, absolute: true });
    for (const file of files) {
      const relPath = path.relative(this.config.memoryDir, file);
      const needsReindex = await this.checkNeedsReindex(relPath, file);
      if (options?.force || needsReindex) await this.indexFile(relPath);
    }

    if (this.config.sessionsDir) {
      const embed = (text: string) => generateEmbedding(text, this.embeddingConfig);
      const sessionChunks = await indexSessions(this.config.sessionsDir, embed);
      for (const chunk of sessionChunks) {
        chunk.metadata.embeddingIdentity = this.identity;
        this.chunks.set(chunk.id, chunk);
        await this.storage?.saveChunk(chunk);
      }
    }

    this.lastSync = Date.now();
  }

  private async checkNeedsReindex(relPath: string, fullPath: string): Promise<boolean> {
    if (!this.storage) return true;
    const stat   = await fs.stat(fullPath).catch(() => null);
    if (!stat) return true;
    const status = await this.storage.getFileStatus(relPath);
    if (!status) return true;
    if (this.embeddingProvider !== 'none') {
      const fileChunks = [...this.chunks.values()].filter(chunk => chunk.path === relPath);
      if (fileChunks.some(chunk => !chunk.embedding)) return true;
    }
    return status.mtime !== stat.mtime.getTime() || status.size !== stat.size;
  }

  private async indexFile(relPath: string): Promise<void> {
    const fullPath = path.join(this.config.memoryDir, relPath);
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      const stat    = await fs.stat(fullPath);

      this.removeFileChunks(relPath);
      await this.storage?.deleteChunksByPath(relPath);

      const chunks = createChunks(relPath, content, stat.mtime, {
        chunkSize: this.chunkSize, chunkOverlap: this.chunkOverlap,
      });

      if (this.embeddingProvider !== 'none') {
        for (const chunk of chunks) {
          chunk.embedding = await generateEmbedding(chunk.content, this.embeddingConfig);
        }
      }

      for (const chunk of chunks) {
        chunk.metadata.embeddingIdentity = this.identity;
        this.chunks.set(chunk.id, chunk);
        await this.storage?.saveChunk(chunk);
      }

      await this.storage?.updateFileStatus(relPath, stat.mtime.getTime(), stat.size);
    } catch (err) {
      log.error('failed to index', { relPath, error: toMessage(err) });
    }
  }

  private removeFileChunks(relPath: string): void {
    // Create an array of keys to remove to avoid modifying map during iteration
    const idsToRemove: string[] = [];
    for (const [id, chunk] of this.chunks) {
      if (chunk.path === relPath) idsToRemove.push(id);
    }
    for (const id of idsToRemove) {
      this.chunks.delete(id);
    }
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  async search(
    query: string,
    options: { maxResults?: number; minScore?: number } = {},
  ): Promise<ContextSearchResult[]> {
    await this.sync();

    const maxResults     = options.maxResults ?? 6;
    const minScore       = options.minScore   ?? 0.3;
    const queryEmbedding = await generateEmbedding(query, this.embeddingConfig);

    // Build initial scores from storage-based vector search if available
    const vectorResults = await this.getVectorScores(queryEmbedding, maxResults, minScore);

    // Build complete scores combining vector and text-based scoring
    const scoredChunks = await this.calculateHybridScores(query, queryEmbedding, vectorResults, minScore);
    
    // Sort by score and return top results
    const sortedResults = scoredChunks.sort((a, b) => b.score - a.score);
    return sortedResults
      .slice(0, maxResults)
      .map(({ chunk, score }) => this.formatSearchResult(chunk, score));
  }

  private async getVectorScores(
    queryEmbedding: number[] | undefined,
    maxResults: number, 
    minScore: number
  ): Promise<Map<string, number>> {
    const vectorResults = new Map<string, number>();
    if (queryEmbedding && this.storage?.searchSimilar) {
      const hits = await this.storage.searchSimilar(queryEmbedding, maxResults * 2, minScore, this.identity);
      for (const { chunk, score } of hits) {
        if (chunk.metadata.embeddingIdentity !== this.identity) continue;
        vectorResults.set(chunk.id, score * this.hybridWeight.vector);
        if (!this.chunks.has(chunk.id)) this.chunks.set(chunk.id, chunk);
      }
    }
    return vectorResults;
  }

  private async calculateHybridScores(
    query: string,
    queryEmbedding: number[] | undefined,
    vectorResults: Map<string, number>,
    minScore: number
  ): Promise<Array<{ chunk: MemoryChunk; score: number }>> {
    const scores: Array<{ chunk: MemoryChunk; score: number }> = [];

    for (const chunk of this.chunks.values()) {
      let score = vectorResults.get(chunk.id) ?? 0;

      // Add vector scoring if storage doesn't support similarity search but query embedding exists
      if (!this.storage?.searchSimilar && queryEmbedding && chunk.embedding && chunk.metadata.embeddingIdentity === this.identity) {
        score += cosineSimilarity(queryEmbedding, chunk.embedding) * this.hybridWeight.vector;
      }

      // Add text-based scoring
      score += textScore(query, chunk.content) * this.hybridWeight.text;
      
      if (score >= minScore) scores.push({ chunk, score });
    }
    
    return scores;
  }

  private formatSearchResult(chunk: MemoryChunk, score: number): ContextSearchResult {
    return {
      chunk,
      score,
      citation: chunk.startLine === chunk.endLine
        ? `${chunk.path}#L${chunk.startLine}`
        : `${chunk.path}#L${chunk.startLine}-L${chunk.endLine}`,
    };
  }

  // ── Reindex (stale cleanup) ──────────────────────────────────────────────

  async reindex(): Promise<{ removed: number; kept: number }> {
    if (!this.storage) return { removed: 0, kept: 0 };

    const files = await glob('**/*.md', { cwd: this.config.memoryDir, absolute: true });
    const activePaths = new Set(files.map(f => path.relative(this.config.memoryDir, f)));

    // Session-derived chunks have paths starting with session dir relative paths
    if (this.config.sessionsDir) {
      const sessionFiles = await glob('**/*.jsonl', { cwd: this.config.sessionsDir, absolute: true });
      for (const sf of sessionFiles) {
        activePaths.add(path.relative(this.config.sessionsDir, sf));
      }
    }

    let removed = 0;
    const trackedPaths = await this.storage.getAllTrackedPaths();

    const removedPaths: string[] = [];
    for (const tracked of trackedPaths) {
      if (!activePaths.has(tracked)) {
        this.removeFileChunks(tracked);
        await this.storage.deleteChunksByPath(tracked);
        removed++;
        removedPaths.push(tracked); // Track what was removed for logging
      }
    }
    
    if (removed > 0) {
      const sampleRemoved = removedPaths.slice(0, 5); // Only log up to 5 paths to avoid log spam
      const remainder = removedPaths.length - sampleRemoved.length;
      log.info('reindex cleaned stale files', { 
        removed, 
        kept: trackedPaths.length - removed, 
        removedFiles: sampleRemoved, 
        ...(remainder > 0 && { moreFilesCount: remainder }) 
      });
    }

    // Re-sync remaining active files
    await this.sync({ reason: 'reindex', force: true });

    return { removed, kept: trackedPaths.length - removed };
  }

  // ── Read / Write ───────────────────────────────────────────────────────────

  private validatePathTraversal(filePath: string, baseDir: string): void {
    // Resolve both paths to canonical form for comparison
    const resolvedBase = path.resolve(baseDir);
    const resolvedPath = path.resolve(filePath);
    
    if (!resolvedPath.startsWith(resolvedBase + path.sep) && resolvedPath !== resolvedBase) {
      throw new Error('Path traversal denied');
    }
  }

  async readFile(params: { relPath: string; from?: number; lines?: number }): Promise<{ path: string; text: string }> {
    const fullPath = path.resolve(this.config.memoryDir, params.relPath);
    this.validatePathTraversal(fullPath, this.config.memoryDir);
    
    const content = await fs.readFile(fullPath, 'utf-8');
    const lines   = content.split('\n');
    const start   = (params.from ?? 1) - 1;
    const end     = params.lines ? start + params.lines : lines.length;
    return { path: params.relPath, text: lines.slice(start, end).join('\n') };
  }

  async writeFile(relPath: string, content: string, mode: 'overwrite' | 'append' = 'overwrite'): Promise<void> {
    const fullPath = path.resolve(this.config.memoryDir, relPath);
    this.validatePathTraversal(fullPath, this.config.memoryDir);
    
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    if (mode === 'append') {
      await fs.appendFile(fullPath, content);
    } else {
      await fs.writeFile(fullPath, content, 'utf-8');
    }
    // Re-index the changed file
    const relNorm = path.relative(this.config.memoryDir, fullPath);
    await this.indexFile(relNorm);
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  getStats(): { files: number; chunks: number; lastSync: Date | null } {
    const files = new Set<string>();
    for (const chunk of this.chunks.values()) files.add(chunk.path);
    return {
      files:    files.size,
      chunks:   this.chunks.size,
      lastSync: this.lastSync ? new Date(this.lastSync) : null,
    };
  }

  // ── File watcher ───────────────────────────────────────────────────────────

  private startFileWatcher(): void {
    if (this.fileWatcher) return;
    try {
      this.fileWatcher = watch(this.config.memoryDir, { recursive: true }, (_, filename) => {
        if (!filename?.endsWith('.md')) return;
        const fullPath = path.join(this.config.memoryDir, filename);
        const existing = this.watcherDebounce.get(fullPath);
        if (existing) clearTimeout(existing);
        const timeout = setTimeout(async () => {
          this.watcherDebounce.delete(fullPath);
          await this.indexFile(filename);
        }, 500);
        this.watcherDebounce.set(fullPath, timeout);
      });
    } catch (err) {
      log.error('failed to start file watcher', { error: toMessage(err) });
    }
  }

  private stopFileWatcher(): void {
    for (const t of this.watcherDebounce.values()) clearTimeout(t);
    this.watcherDebounce.clear();
    this.fileWatcher?.close();
    this.fileWatcher = null;
  }
}
