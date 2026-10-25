export interface MemoryChunk {
  id:         string;
  path:       string;
  content:    string;
  startLine:  number;
  endLine:    number;
  embedding?: number[];
  metadata: {
    date:  string;
    size:  number;
    [key: string]: unknown;
  };
}

export interface MemoryStorage {
  initialize(): Promise<void>;
  saveChunk(chunk: MemoryChunk): Promise<void>;
  getAllChunks(): Promise<MemoryChunk[]>;
  deleteChunksByPath(filePath: string): Promise<void>;
  updateFileStatus(path: string, mtime: number, size: number): Promise<void>;
  getFileStatus(path: string): Promise<{ mtime: number; size: number; indexedAt: number } | null>;
  /** All distinct paths currently tracked in the files table (for stale cleanup). */
  getAllTrackedPaths(): Promise<string[]>;
  /** Atomically discard the derived index and file tracking; source files are untouched. */
  clear(): Promise<void>;
  close(): Promise<void>;
  searchSimilar?(embedding: number[], limit: number, minScore?: number, identity?: string): Promise<Array<{ chunk: MemoryChunk; score: number }>>;
}
