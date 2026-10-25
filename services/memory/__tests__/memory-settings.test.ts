import { describe, expect, it } from 'vitest';
import { AppConfigSchema } from '../../config/index.js';
import { MemoryConfigSchema, resolveMemoryConfig } from '../../config/schemas/memory.js';

describe('memory settings', () => {
  it('defaults to keyword search without credentials', () => {
    expect(resolveMemoryConfig({})).toMatchObject({ provider: 'keyword', model: 'text-embedding-3-small' });
  });
  it('validates the new top-level section', () => {
    expect(AppConfigSchema.parse({ memory: { provider: 'openai', key: 'test' } }).memory)
      .toMatchObject({ provider: 'openai', key: 'test' });
    expect(MemoryConfigSchema.safeParse({ provider: 'openai' }).success).toBe(false);
    expect(MemoryConfigSchema.safeParse({ provider: 'local' }).success).toBe(false);
    expect(MemoryConfigSchema.safeParse({ chunkSize: 10, chunkOverlap: 10 }).success).toBe(false);
  });
  it('defaults Ollama independently and accepts no API key', () => {
    expect(MemoryConfigSchema.parse({ provider: 'ollama' })).toMatchObject({ provider: 'ollama', model: 'embeddinggemma' });
    expect(MemoryConfigSchema.safeParse({ provider: 'ollama', baseUrl: 'file:///tmp/server' }).success).toBe(false);
  });
  it('keeps legacy agent settings working', () => {
    expect(resolveMemoryConfig({ agent: {
      memoryEmbeddingProvider: 'openai', memoryEmbeddingApiKey: 'old-key',
      memoryEmbeddingModel: 'old-model', memoryChunkSize: 200,
    } })).toMatchObject({ provider: 'openai', key: 'old-key', model: 'old-model', chunkSize: 200 });
  });
  it('keeps legacy root settings working', () => {
    expect(resolveMemoryConfig({ embeddingProvider: 'openai', embeddingOpenAiKey: 'old-key' }))
      .toMatchObject({ provider: 'openai', key: 'old-key' });
  });
  it('gives explicit keyword selection precedence over old embedding settings', () => {
    const resolved = resolveMemoryConfig({ memory: { provider: 'keyword' }, agent: {
      memoryEmbeddingProvider: 'openai', memoryEmbeddingApiKey: 'old-key',
    } });
    expect(resolved.provider).toBe('keyword');
    expect(resolved.key).toBeUndefined();
  });
});
