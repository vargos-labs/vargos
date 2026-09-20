import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MemoryPostgresStorage } from '../providers/psql.js';
import type { MemoryChunk } from '../types.js';

// Live integration test — set VARGOS_TEST_PG_URL to a scratch database to run,
// e.g. VARGOS_TEST_PG_URL=postgresql://user:pass@host:5432/testdb pnpm vitest run psql-storage
const PG_URL = process.env.VARGOS_TEST_PG_URL;
const PREFIX = `memtest_${Date.now()}`; // isolated tables, safe on shared DBs

describe.skipIf(!PG_URL)('MemoryPostgresStorage (live)', () => {
  let storage: MemoryPostgresStorage;

  beforeAll(async () => {
    storage = new MemoryPostgresStorage(PG_URL!, { tablePrefix: PREFIX });
    await storage.initialize();
  });

  afterAll(async () => {
    await storage.close();
  });

  it('saves and retrieves chunks', async () => {
    const chunk: MemoryChunk = {
      id: 'test-chunk-1',
      path: 'test/document.md',
      content: 'This is a test chunk content.',
      startLine: 1,
      endLine: 3,
      metadata: { date: new Date().toISOString(), size: 30, testField: 'test value' },
    };

    await storage.saveChunk(chunk);

    const chunks = await storage.getAllChunks();
    expect(chunks).toHaveLength(1);
    const retrieved = chunks[0];
    expect(retrieved.id).toBe(chunk.id);
    expect(retrieved.path).toBe(chunk.path);
    expect(retrieved.content).toBe(chunk.content);
    expect(retrieved.startLine).toBe(chunk.startLine);
    expect(retrieved.endLine).toBe(chunk.endLine);
    expect(retrieved.metadata).toEqual(chunk.metadata);
  });

  it('handles chunks with embedding vector (round-trip)', async () => {
    const chunk: MemoryChunk = {
      id: 'embed-test',
      path: 'test/embed.md',
      content: 'Chunk with embedding test',
      startLine: 1,
      endLine: 1,
      embedding: [0.1, 0.2, 0.3, 0.4],
      metadata: { date: new Date().toISOString(), size: 25 },
    };

    await storage.saveChunk(chunk);

    const chunks = await storage.getAllChunks();
    expect(chunks.find(c => c.id === 'embed-test')?.embedding).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('searchSimilar ranks by cosine similarity', async () => {
    // Orthogonal-ish vectors in 4d: [1,0,0,0] vs [0,1,0,0] vs [0.98,0.2,0,0]
    await storage.saveChunk({ id: 'sim-a', path: 'sim/a.md', content: 'a', startLine: 1, endLine: 1, embedding: [0.98, 0.2, 0, 0], metadata: {} });
    await storage.saveChunk({ id: 'sim-b', path: 'sim/b.md', content: 'b', startLine: 1, endLine: 1, embedding: [0, 1, 0, 0], metadata: {} });

    const hits = await storage.searchSimilar([1, 0, 0, 0], 5);
    const byId = new Map(hits.map(h => [h.chunk.id, h.score]));
    // sim-a (≈0.98) must outrank sim-b (≈0.0); earlier test vectors must not interfere
    expect(byId.get('sim-a')).toBeGreaterThan(byId.get('sim-b')!);
    expect(byId.get('sim-a')!).toBeGreaterThan(0.9);
    expect(byId.get('sim-b')!).toBeLessThan(0.1);
  });

  it('manages file tracking correctly', async () => {
    await storage.updateFileStatus('test/tracking.md', 1678886400000, 1234);

    const status = await storage.getFileStatus('test/tracking.md');
    expect(status).toEqual({ mtime: 1678886400000, size: 1234, indexedAt: expect.any(Number) });

    expect(await storage.getFileStatus('nonexistent.md')).toBeNull();
  });

  it('deletes chunks by file path', async () => {
    await storage.saveChunk({ id: 'del-1', path: 'del/file.md', content: 'First', startLine: 1, endLine: 2, metadata: {} });
    await storage.saveChunk({ id: 'del-2', path: 'del/file.md', content: 'Second', startLine: 3, endLine: 4, metadata: {} });
    await storage.saveChunk({ id: 'del-3', path: 'del/other.md', content: 'Other', startLine: 1, endLine: 1, metadata: {} });

    await storage.deleteChunksByPath('del/file.md');

    const chunks = await storage.getAllChunks();
    const delChunks = chunks.filter(c => c.path.startsWith('del/'));
    expect(delChunks).toHaveLength(1);
    expect(delChunks[0].id).toBe('del-3');
  });

  it('provides list of all tracked paths', async () => {
    await storage.updateFileStatus('test/file1.md', 1678886400000, 1234);
    await storage.updateFileStatus('another/file2.md', 1678886500000, 5678);

    const tracked = await storage.getAllTrackedPaths();
    expect(tracked).toContain('test/file1.md');
    expect(tracked).toContain('another/file2.md');
    expect([...tracked].sort()).toEqual(tracked);
  });

  it('updates stored chunks when saving with same ID', async () => {
    await storage.saveChunk({ id: 'update-test', path: 'original/path.md', content: 'Original', startLine: 1, endLine: 1, metadata: {} });
    await storage.saveChunk({ id: 'update-test', path: 'updated/path.md', content: 'Updated', startLine: 1, endLine: 1, metadata: {} });

    const chunks = (await storage.getAllChunks()).filter(c => c.id === 'update-test');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('Updated');
    expect(chunks[0].path).toBe('updated/path.md');
  });

  it('tolerates mixed embedding dimensions (dimensionless vector column)', async () => {
    // Table already has 4-d embeddings → 3-d insert must still succeed
    await storage.saveChunk({ id: 'dim-mix', path: 'dim/x.md', content: 'Dims differ', startLine: 1, endLine: 1, embedding: [0.1, 0.2, 0.3], metadata: {} });
    const chunks = (await storage.getAllChunks()).filter(c => c.id === 'dim-mix');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].embedding).toEqual([0.1, 0.2, 0.3]);

    // Query-time dimension mismatch degrades to no vector hits, not a throw
    const hits = await storage.searchSimilar([0, 0, 0, 0, 1], 5);
    expect(hits).toEqual([]);
  });
});
