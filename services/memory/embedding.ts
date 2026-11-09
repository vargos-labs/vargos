import { createHash } from 'node:crypto';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('memory');

export interface EmbeddingConfig {
  provider: 'openai' | 'ollama' | 'local' | 'none';
  openaiApiKey?: string;
  model?: string;
  baseUrl?: string;
}

/** Credentials do not change the vector space; provider, model and endpoint do. */
export function embeddingIdentity(config: EmbeddingConfig): string {
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    provider: config.provider,
    model: config.provider === 'none' ? '' : config.model ?? (config.provider === 'ollama' ? 'embeddinggemma' : 'text-embedding-3-small'),
    endpoint: config.provider === 'none' ? '' : embeddingBaseUrl(config),
  })).digest('hex');
}

function embeddingBaseUrl(config: EmbeddingConfig): string {
  return (config.baseUrl ?? (config.provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
}

export async function generateEmbedding(text: string, config: EmbeddingConfig): Promise<number[] | undefined> {
  if (config.provider === 'none' || config.provider === 'local') return undefined;
  if (config.provider === 'openai' && !config.openaiApiKey) return undefined;
  const ollama = config.provider === 'ollama';
  try {
    const response = await fetch(`${embeddingBaseUrl(config)}/${ollama ? 'api/embed' : 'embeddings'}`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: {
        'Content-Type': 'application/json',
        ...(config.openaiApiKey ? { Authorization: `Bearer ${config.openaiApiKey}` } : {}),
      },
      body: JSON.stringify({
        input: text.slice(0, 8000),
        model: config.model ?? (ollama ? 'embeddinggemma' : 'text-embedding-3-small'),
      }),
    });
    if (!response.ok) {
      log.warn(`embedding request failed provider=${config.provider} status=${response.status}; using keyword matching`);
      return undefined;
    }
    const data = await response.json() as { embeddings?: unknown[]; data?: Array<{ embedding?: unknown }> };
    const vector = ollama ? data.embeddings?.[0] : data.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every(value => typeof value === 'number' && Number.isFinite(value))) {
      log.warn(`invalid embedding response provider=${config.provider}; using keyword matching`);
      return undefined;
    }
    return vector as number[];
  } catch {
    // Do not log request details or credentials.
    log.warn(`embedding request unavailable provider=${config.provider}; using keyword matching`);
    return undefined;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

export function textScore(query: string, content: string): number {
  const queryTerms = query.toLowerCase().split(/\W+/).filter(t => t.length > 2);
  const contentLower = content.toLowerCase();
  if (queryTerms.length === 0) return 0;
  let matches = 0;
  for (const term of queryTerms) {
    if (contentLower.includes(term)) matches++;
  }
  return matches / queryTerms.length;
}
