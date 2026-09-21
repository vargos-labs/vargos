/**
 * Postgres storage provider — pg (node-postgres) with pgvector for native
 * cosine similarity search. Mirrors MemorySQLiteStorage semantics; requires
 * the `vector` extension (auto-created on initialize when allowed).
 */

import { Pool } from 'pg';
import type { MemoryChunk, MemoryStorage } from '../types.js';
import { createLogger } from '../../../lib/logger.js';

const log = createLogger('memory:postgres');

export interface MemoryPostgresOptions {
  /** Table prefix (default 'memory' → memory_chunks / memory_files). */
  tablePrefix?: string;
}

export class MemoryPostgresStorage implements MemoryStorage {
  private pool: Pool | null = null;
  private dimensionMismatchWarned = false;
  private readonly cTable: string;
  private readonly fTable: string;

  constructor(private readonly connectionString: string, options: MemoryPostgresOptions = {}) {
    const prefix = options.tablePrefix ?? 'memory';
    this.cTable = `${prefix}_chunks`;
    this.fTable = `${prefix}_files`;
  }

  async initialize(): Promise<void> {
    this.pool = new Pool({ connectionString: this.connectionString, max: 5 });
    const client = await this.pool.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.cTable} (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          content TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          embedding vector,
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_${this.cTable}_path ON ${this.cTable}(path);
        CREATE TABLE IF NOT EXISTS ${this.fTable} (
          path TEXT PRIMARY KEY,
          mtime BIGINT NOT NULL,
          size BIGINT NOT NULL,
          indexed_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      // HNSW index — best-effort; sequential scan is fine at current scale.
      try {
        await client.query(
          `CREATE INDEX IF NOT EXISTS idx_${this.cTable}_embedding ON ${this.cTable} USING hnsw (embedding vector_cosine_ops)`,
        );
      } catch { /* non-fatal */ }
    } finally {
      client.release();
    }
  }

  /** pgvector text format: "[0.1,0.2,...]" */
  private static toVectorText(embedding: number[]): string {
    return `[${embedding.join(',')}]`;
  }

  async saveChunk(chunk: MemoryChunk): Promise<void> {
    const client = await this.pool!.connect();
    try {
      await client.query(
        `INSERT INTO ${this.cTable} (id, path, content, start_line, end_line, embedding, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::text::vector, $7)
         ON CONFLICT (id) DO UPDATE SET
           path = EXCLUDED.path,
           content = EXCLUDED.content,
           start_line = EXCLUDED.start_line,
           end_line = EXCLUDED.end_line,
           embedding = EXCLUDED.embedding,
           metadata = EXCLUDED.metadata`,
        [
          chunk.id, chunk.path, chunk.content, chunk.startLine, chunk.endLine,
          chunk.embedding ? MemoryPostgresStorage.toVectorText(chunk.embedding) : null,
          JSON.stringify(chunk.metadata),
        ],
      );
    } catch (err) {
      // Embedding from a different-dimension model than earlier rows → retry
      // without embedding rather than losing the chunk entirely.
      if (chunk.embedding && /dimensions/i.test(String(err))) {
        if (!this.dimensionMismatchWarned) {
          this.dimensionMismatchWarned = true;
          log.warn('embedding dimension mismatch — saving chunk without embedding (switched embedding model?)');
        }
        await client.query(
          `INSERT INTO ${this.cTable} (id, path, content, start_line, end_line, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE SET
             path = EXCLUDED.path,
             content = EXCLUDED.content,
             start_line = EXCLUDED.start_line,
             end_line = EXCLUDED.end_line,
             metadata = EXCLUDED.metadata`,
          [chunk.id, chunk.path, chunk.content, chunk.startLine, chunk.endLine, JSON.stringify(chunk.metadata)],
        );
      } else {
        throw err;
      }
    } finally {
      client.release();
    }
  }

  async getAllChunks(): Promise<MemoryChunk[]> {
    const res = await this.pool!.query(`SELECT * FROM ${this.cTable} ORDER BY path, start_line`);
    return res.rows.map(r => this.rowToChunk(r as Record<string, unknown>));
  }

  async deleteChunksByPath(filePath: string): Promise<void> {
    await this.pool!.query(`DELETE FROM ${this.cTable} WHERE path = $1`, [filePath]);
  }

  async updateFileStatus(filePath: string, mtime: number, size: number): Promise<void> {
    await this.pool!.query(
      `INSERT INTO ${this.fTable} (path, mtime, size, indexed_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (path) DO UPDATE SET mtime = EXCLUDED.mtime, size = EXCLUDED.size, indexed_at = now()`,
      [filePath, mtime, size],
    );
  }

  async getFileStatus(filePath: string): Promise<{ mtime: number; size: number; indexedAt: number } | null> {
    const res = await this.pool!.query(`SELECT * FROM ${this.fTable} WHERE path = $1`, [filePath]);
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      mtime: Number(row.mtime),
      size: Number(row.size),
      indexedAt: new Date(row.indexed_at as string).getTime(),
    };
  }

  async getAllTrackedPaths(): Promise<string[]> {
    const res = await this.pool!.query(`SELECT DISTINCT path FROM ${this.fTable} ORDER BY path`);
    return res.rows.map(r => (r as { path: string }).path);
  }

  /** Native pgvector cosine similarity. Score = 1 − cosine distance.
   *  Dimensionless columns tolerate mixed dimensions (embedding model swap);
   *  a mismatch surfaces at query time — degrade to no vector hits. */
  async searchSimilar(
    embedding: number[],
    limit: number,
    minScore?: number,
  ): Promise<Array<{ chunk: MemoryChunk; score: number }>> {
    let res;
    try {
      res = await this.pool!.query(
        `SELECT *, 1 - (embedding <=> $1::text::vector) AS score
         FROM ${this.cTable}
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::text::vector
         LIMIT $2`,
        [MemoryPostgresStorage.toVectorText(embedding), limit],
      );
    } catch (err) {
      if (/dimensions/i.test(String(err)) && !this.dimensionMismatchWarned) {
        this.dimensionMismatchWarned = true;
        log.warn('embedding dimension mismatch at query time — vector search disabled until reindex (switched embedding model?)');
      }
      return [];
    }
    const floor = minScore ?? 0;
    return res.rows
      // fp jitter: distances can land at 0.9999999999 / 1.0000000001
      .map(r => ({ chunk: this.rowToChunk(r as Record<string, unknown>), score: Math.min(1, Math.max(0, Number((r as { score: number }).score))) }))
      .filter(({ score }) => score >= floor);
  }

  /** pgvector returns vectors as text: "[0.1,0.2,...]" */
  private rowToChunk(row: Record<string, unknown>): MemoryChunk {
    const raw = row.embedding as string | null;
    return {
      id:        row.id as string,
      path:      row.path as string,
      content:   row.content as string,
      startLine: row.start_line as number,
      endLine:   row.end_line as number,
      embedding: raw ? JSON.parse(raw) : undefined,
      metadata:  row.metadata as MemoryChunk['metadata'],
    };
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }
}
