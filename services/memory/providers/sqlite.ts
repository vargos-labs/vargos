/**
 * SQLite storage provider — uses better-sqlite3 with chunk + file tracking tables.
 */

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { MemoryChunk, MemoryStorage } from '../types.js';

export class MemorySQLiteStorage implements MemoryStorage {
  private db: BetterSqlite3.Database | null = null;

  constructor(private readonly dbPath: string) {}

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = DELETE');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        embedding TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
  }

  async saveChunk(chunk: MemoryChunk): Promise<void> {
    this.db!.prepare(
      `INSERT OR REPLACE INTO chunks (id, path, content, start_line, end_line, embedding, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      chunk.id, chunk.path, chunk.content, chunk.startLine, chunk.endLine,
      chunk.embedding ? JSON.stringify(chunk.embedding) : null,
      JSON.stringify(chunk.metadata),
    );
  }

  async getAllChunks(): Promise<MemoryChunk[]> {
    const rows = this.db!.prepare('SELECT * FROM chunks ORDER BY path, start_line').all();
    return rows.map(r => this.rowToChunk(r as Record<string, unknown>));
  }

  async deleteChunksByPath(filePath: string): Promise<void> {
    this.db!.prepare('DELETE FROM chunks WHERE path = ?').run(filePath);
  }

  async updateFileStatus(filePath: string, mtime: number, size: number): Promise<void> {
    this.db!.prepare(
      'INSERT OR REPLACE INTO files (path, mtime, size, indexed_at) VALUES (?, ?, ?, unixepoch())',
    ).run(filePath, mtime, size);
  }

  async getFileStatus(filePath: string): Promise<{ mtime: number; size: number; indexedAt: number } | null> {
    const row = this.db!.prepare('SELECT * FROM files WHERE path = ?').get(filePath) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { mtime: row.mtime as number, size: row.size as number, indexedAt: row.indexed_at as number };
  }

  async getAllTrackedPaths(): Promise<string[]> {
    const rows = this.db!.prepare('SELECT DISTINCT path FROM files ORDER BY path').all() as Array<{ path: string }>;
    return rows.map(r => r.path);
  }

  async getStats(): Promise<{ fileCount: number; chunkCount: number }> {
    const f = this.db!.prepare('SELECT COUNT(*) as count FROM files').get() as { count: number };
    const c = this.db!.prepare('SELECT COUNT(*) as count FROM chunks').get() as { count: number };
    return { fileCount: f?.count ?? 0, chunkCount: c?.count ?? 0 };
  }

  async clear(): Promise<void> {
    this.db!.transaction(() => {
      this.db!.exec('DELETE FROM chunks; DELETE FROM files;');
    })();
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  private rowToChunk(row: Record<string, unknown>): MemoryChunk {
    return {
      id:        row.id as string,
      path:      row.path as string,
      content:   row.content as string,
      startLine: row.start_line as number,
      endLine:   row.end_line as number,
      embedding: row.embedding ? JSON.parse(row.embedding as string) : undefined,
      metadata:  row.metadata ? JSON.parse(row.metadata as string) : {},
    };
  }
}
