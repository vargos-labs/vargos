import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryContext, type MemoryContextConfig } from '../context.js';
import { MemorySQLiteStorage } from '../providers/sqlite.js';

describe('embedding model switches with persistent SQLite storage', () => {
  let dir: string;
  let context: MemoryContext | undefined;
  let storage: MemorySQLiteStorage;
  let fetch: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'embedding-switch-'));
    await mkdir(path.join(dir, 'workspace'));
    await writeFile(path.join(dir, 'workspace', 'memory.md'), 'deployment status is healthy');
    fetch = vi.fn().mockImplementation(async (url: string) => url.includes('/api/embed')
      ? Response.json({ embeddings: [[0, 1, 0]] })
      : Response.json({ data: [{ embedding: [1, 0] }] }));
    vi.stubGlobal('fetch', fetch);
  });
  afterEach(async () => {
    await context?.close();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });
  async function start(options: Partial<MemoryContextConfig>) {
    await context?.close();
    storage = new MemorySQLiteStorage(path.join(dir, 'memory.db'));
    context = new MemoryContext({ memoryDir: path.join(dir, 'workspace'), cacheDir: path.join(dir, 'cache'), storage, ...options });
    await context.initialize();
    return storage.getAllChunks();
  }

  it('automatically replaces old vectors on provider switch even when source files are unchanged', async () => {
    expect((await start({ embeddingProvider: 'openai', openaiApiKey: 'test' }))[0].embedding).toEqual([1, 0]);
    const rebuilt = await start({ embeddingProvider: 'ollama' });
    expect(rebuilt[0].embedding).toEqual([0, 1, 0]);
    expect(await readFile(path.join(dir, 'workspace', 'memory.md'), 'utf8')).toBe('deployment status is healthy');
    expect(await context!.search('deployment')).toHaveLength(1);
  });
  it.each([{ embeddingModel: 'different-model' }, { embeddingBaseUrl: 'http://another-host:11434' }])('rebuilds for configuration change %j', async changed => {
    const original = await start({ embeddingProvider: 'ollama' });
    fetch.mockClear();
    const rebuilt = await start({ embeddingProvider: 'ollama', ...changed });
    expect(fetch).toHaveBeenCalled();
    expect(rebuilt[0].metadata.embeddingIdentity).not.toBe(original[0].metadata.embeddingIdentity);
  });
  it('does not re-embed unchanged files for a credential-only change', async () => {
    await start({ embeddingProvider: 'openai', openaiApiKey: 'first-key' });
    fetch.mockClear();
    await start({ embeddingProvider: 'openai', openaiApiKey: 'second-key' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('discards incompatible vectors even if the new provider is unavailable', async () => {
    await start({ embeddingProvider: 'openai', openaiApiKey: 'test' });
    fetch.mockRejectedValue(new Error('offline'));
    const chunks = await start({ embeddingProvider: 'ollama' });
    expect(chunks[0].embedding).toBeUndefined();
    expect(await context!.search('deployment', { minScore: 0 })).toHaveLength(1);
  });
  it('switches back to keyword mode without embedding API calls', async () => {
    await start({ embeddingProvider: 'ollama' });
    fetch.mockClear();
    const chunks = await start({ embeddingProvider: 'none' });
    expect(chunks[0].embedding).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rebuilds unversioned legacy index rows', async () => {
    const chunks = await start({ embeddingProvider: 'ollama' });
    delete chunks[0].metadata.embeddingIdentity;
    chunks[0].embedding = [99, 99];
    await storage.saveChunk(chunks[0]);
    expect((await start({ embeddingProvider: 'ollama' }))[0].embedding).toEqual([0, 1, 0]);
  });
});
