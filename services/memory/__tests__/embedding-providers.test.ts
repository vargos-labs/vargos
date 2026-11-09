import { afterEach, describe, expect, it, vi } from 'vitest';
import { cosineSimilarity, embeddingIdentity, generateEmbedding } from '../embedding.js';

afterEach(() => vi.unstubAllGlobals());

describe('embedding provider requests', () => {
  it('uses native Ollama embed format without requiring credentials', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ embeddings: [[0.2, 0.8]] }));
    vi.stubGlobal('fetch', fetch);
    expect(await generateEmbedding('hello', { provider: 'ollama', baseUrl: 'http://localhost:11434/' })).toEqual([0.2, 0.8]);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/embed');
    expect(JSON.parse(options.body)).toEqual({ input: 'hello', model: 'embeddinggemma' });
    expect(options.headers.Authorization).toBeUndefined();
  });
  it('retains the OpenAI request format', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: [{ embedding: [0.1, 0.9] }] }));
    vi.stubGlobal('fetch', fetch);
    expect(await generateEmbedding('hello', { provider: 'openai', openaiApiKey: 'test-key' })).toEqual([0.1, 0.9]);
    expect(fetch.mock.calls[0][0]).toBe('https://api.openai.com/v1/embeddings');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-key');
  });
  it.each([{}, { embeddings: [[]] }, { embeddings: [['invalid']] }])('rejects malformed vectors: %j', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
    expect(await generateEmbedding('hello', { provider: 'ollama' })).toBeUndefined();
  });
  it('falls back safely when the server is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await generateEmbedding('hello', { provider: 'ollama' })).toBeUndefined();
  });
  it('does not call an API for keyword search', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await generateEmbedding('hello', { provider: 'none' })).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('ignores credentials in identity but distinguishes models and endpoints', () => {
    const config = { provider: 'openai' as const, model: 'model-a' };
    expect(embeddingIdentity({ ...config, openaiApiKey: 'a' })).toBe(embeddingIdentity({ ...config, openaiApiKey: 'b' }));
    expect(embeddingIdentity(config)).not.toBe(embeddingIdentity({ ...config, model: 'model-b' }));
    expect(embeddingIdentity(config)).not.toBe(embeddingIdentity({ ...config, baseUrl: 'http://localhost:1234' }));
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
});
