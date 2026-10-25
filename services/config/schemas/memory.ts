/** Memory search configuration, independent of agent inference settings. */
import { z } from 'zod';

export const MemoryConfigSchema = z.object({
  provider: z.enum(['keyword', 'openai', 'ollama']).default('keyword')
    .describe('Keyword search (default, no API calls) or OpenAI/Ollama embeddings with keyword matching'),
  key: z.string().trim().min(1).optional().describe('Dedicated embedding API key'),
  model: z.string().trim().min(1).optional(),
  baseUrl: z.url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol), 'Use an HTTP or HTTPS URL').optional(),
  chunkSize: z.number().int().positive().default(400),
  chunkOverlap: z.number().int().nonnegative().default(80),
  hybridWeight: z.object({
    vector: z.number().min(0).max(1),
    text: z.number().min(0).max(1),
  }).default({ vector: 0.7, text: 0.3 }),
}).superRefine((config, ctx) => {
  if (config.provider === 'openai' && !config.key) {
    ctx.addIssue({ code: 'custom', path: ['key'], message: 'An API key is required for OpenAI embeddings' });
  }
  if (config.chunkOverlap >= config.chunkSize) {
    ctx.addIssue({ code: 'custom', path: ['chunkOverlap'], message: 'Must be smaller than chunkSize' });
  }
}).transform(config => ({
  ...config,
  model: config.model ?? (config.provider === 'ollama' ? 'embeddinggemma' : 'text-embedding-3-small'),
}));

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

/** Explicit memory settings win; continue reading older installs until they are saved. */
export function resolveMemoryConfig(config: Record<string, unknown>): MemoryConfig {
  if (config.memory !== undefined) return MemoryConfigSchema.parse(config.memory);
  const agent = (config.agent ?? {}) as Record<string, unknown>;
  const provider = agent.memoryEmbeddingProvider ?? config.embeddingProvider;
  return MemoryConfigSchema.parse({
    provider: provider === 'openai' ? 'openai' : 'keyword',
    key: agent.memoryEmbeddingApiKey ?? config.embeddingOpenAiKey,
    model: agent.memoryEmbeddingModel ?? config.embeddingModel,
    chunkSize: agent.memoryChunkSize ?? config.chunkSize,
    chunkOverlap: agent.memoryChunkOverlap ?? config.chunkOverlap,
    hybridWeight: agent.memoryHybridWeight ?? config.hybridWeight,
  });
}
