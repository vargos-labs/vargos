import { resolveMemoryConfig } from '../config/schemas/memory.js';
import path from 'node:path';
import { z } from 'zod';
import type { Bus, Service } from '../../core/types.js';
import type { AppConfig } from '../config/index.js';
import { getDataPaths } from '../../lib/paths.js';
import { MemoryContext } from './context.js';
import { MemorySQLiteStorage } from './providers/sqlite.js';
import { MemoryPostgresStorage } from './providers/psql.js';
import { createLogger } from '../../lib/logger.js';
import type { MemoryStorage } from './types.js';

export const BOOT_PRIORITY = 10; // vector search / tool registration before agent runs
export class MemoryService implements Service {
  readonly name = 'memory';
  protected readonly log = createLogger('memory');
  protected context!: MemoryContext;

  private createStorage(dataDir: string, storage?: { type?: string; url?: string }): MemoryStorage {
    const type = storage?.type ?? 'sqlite';
    switch (type) {
      case 'sqlite':
        return new MemorySQLiteStorage(path.join(dataDir, 'memory.db'));
      case 'postgres': {
        if (!storage?.url) {
          this.log.warn('storage.type is postgres but storage.url is missing — falling back to sqlite');
          return new MemorySQLiteStorage(path.join(dataDir, 'memory.db'));
        }
        return new MemoryPostgresStorage(storage.url);
      }
      default:
        throw new Error(`Unknown storage type: ${type}`);
    }
  }

  async init(bus: Bus): Promise<void> {
    this.log.info('Initializing memory service');

    const config = await bus.call<AppConfig>('config.get', {});
    const { workspaceDir, cacheDir, sessionsDir, dataDir } = getDataPaths();
    const storage = this.createStorage(dataDir, config.storage);

    const memory = resolveMemoryConfig(config);

    this.context = new MemoryContext({
      memoryDir: workspaceDir,
      cacheDir,
      sessionsDir,
      storage,
      enableFileWatcher: true,
      embeddingProvider: memory.provider === 'keyword' ? 'none' : memory.provider,
      openaiApiKey: memory.key,
      embeddingModel: memory.model,
      embeddingBaseUrl: memory.baseUrl,
      chunkSize: memory.chunkSize,
      chunkOverlap: memory.chunkOverlap,
      hybridWeight: memory.hybridWeight,
    });

    await this.context.initialize();

    bus.register('memory.search', {
      description: 'Semantically search MEMORY.md + memory/*.md for relevant content.',
      schema: z.object({
        query: z.string().describe('Search query'),
        maxResults: z.number().optional().describe('Max results (default 6)'),
        minScore: z.number().optional().describe('Min relevance score 0-1 (default 0.3)'),
      }),
      cli: { positional: ['query'] },
    }, (p) => this.search(p));

    bus.register('memory.read', {
      description: 'Read a file from the workspace memory directory.',
      schema: z.object({
        path: z.string().describe('Relative path within workspace'),
        from: z.number().optional().describe('Start line (1-based)'),
        lines: z.number().optional().describe('Number of lines to read'),
      }),
      cli: { positional: ['path'] },
    }, (p) => this.context.readFile({ relPath: p.path, from: p.from, lines: p.lines }));

    bus.register('memory.write', {
      description: 'Write or append to a file in the workspace memory directory.',
      schema: z.object({
        path: z.string().describe('Relative path within workspace'),
        content: z.string(),
        mode: z.enum(['overwrite', 'append']).optional().describe('Default: overwrite'),
      }),
      cli: { positional: ['path', 'content'] },
    }, (p) => this.context.writeFile(p.path, p.content, p.mode ?? 'overwrite'));

    bus.register('memory.reindex', {
      description: 'Remove stale chunks for deleted files and re-sync all active files. Returns counts of removed and kept files.',
      schema: z.object({}),
    }, () => this.context.reindex());

    bus.register('memory.stats', {
      description: 'Get memory index stats (file count, chunk count, last sync).',
      schema: z.object({}),
    }, () => this.context.getStats());
  }

  async dispose(): Promise<void> {
    this.log.info('Closing memory service');
    await this.context.close();
  }

  private async search(params: { query: string; maxResults?: number; minScore?: number }) {
    const results = await this.context.search(params.query, {
      maxResults: params.maxResults,
      minScore: params.minScore,
    });
    return results.map(r => ({
      citation: r.citation,
      score: r.score,
      content: r.chunk.content,
      startLine: r.chunk.startLine,
      endLine: r.chunk.endLine,
    }));
  }
}

export function createService(): Service {
  return new MemoryService();
}
