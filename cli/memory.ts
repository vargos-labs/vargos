/** Post-install memory configuration; no network requests or reindexing on save. */
import * as p from '@clack/prompts';
import { getDataPaths } from '../lib/paths.js';
import { readJson, writeJson } from '../lib/util.js';
import { MemoryConfigSchema, resolveMemoryConfig } from '../services/config/schemas/memory.js';

export async function configureMemory(): Promise<void> {
  const { configFile, agentSettingsFile } = getDataPaths();
  const config = readJson<Record<string, unknown>>(configFile);
  if (!config) {
    p.log.error('Cannot read config.json. Run setup or repair the configuration first.');
    return;
  }
  const settings = readJson<Record<string, unknown>>(agentSettingsFile);
  // Read legacy settings from the same merged view used by the daemon.
  const current = resolveMemoryConfig({
    ...config, agent: { ...(config.agent as Record<string, unknown>), ...settings },
  });
  const provider = await p.select({
    message: 'Memory search',
    initialValue: current.provider,
    options: [
      { value: 'keyword', label: 'Keyword search (default)', hint: 'local text matching; no embedding API calls' },
      { value: 'ollama', label: 'Local embeddings (Ollama)', hint: 'uses your Ollama server; no OpenAI key required' },
      { value: 'openai', label: 'OpenAI embeddings + keyword search', hint: 'sends indexed text to OpenAI; API usage applies' },
    ],
  });
  if (p.isCancel(provider)) return;

  let key = provider === current.provider ? current.key : undefined;
  let baseUrl = provider === current.provider ? current.baseUrl : undefined;
  let model = provider === current.provider ? current.model : MemoryConfigSchema.parse({ provider: provider === 'openai' ? 'keyword' : provider }).model;
  if (provider === 'openai') {
    const enteredKey = await p.password({
      message: key ? 'Embedding API key (leave blank to keep current)' : 'Embedding API key',
      validate: (value) => !value?.trim() && !key ? 'Required' : undefined,
    });
    if (p.isCancel(enteredKey)) return;
    key = enteredKey.trim() || key;
  }
  if (provider === 'ollama') {
    const endpoint = await p.text({
      message: 'Ollama server URL',
      defaultValue: baseUrl ?? 'http://127.0.0.1:11434',
      placeholder: 'http://127.0.0.1:11434',
      validate: (value) => {
        if (!value) return undefined;
        return MemoryConfigSchema.safeParse({ provider: 'ollama', baseUrl: value.trim() }).success ? undefined : 'Enter an HTTP or HTTPS server URL';
      },
    });
    if (p.isCancel(endpoint)) return;
    baseUrl = endpoint.trim() || baseUrl || 'http://127.0.0.1:11434';
  }
  if (provider !== 'keyword') {
    const enteredModel = await p.text({
      message: 'Embedding model',
      defaultValue: model,
      placeholder: model,
      validate: (value) => value !== undefined && value.length > 0 && !value.trim() ? 'Enter a model name' : undefined,
    });
    if (p.isCancel(enteredModel)) return;
    model = enteredModel.trim() || model;
  }

  const memory = MemoryConfigSchema.parse({
    ...current, provider, key: provider === 'keyword' ? undefined : key, model, baseUrl: provider === 'keyword' ? undefined : baseUrl,
  });
  // Re-read before writing to preserve other changes made while prompts were open.
  const latest = readJson<Record<string, unknown>>(configFile);
  if (!latest) {
    p.log.error('Cannot read config.json. No changes saved.');
    return;
  }
  writeJson(configFile, { ...latest, memory });
  p.log.success(provider === 'keyword' ? 'Keyword memory search saved.' : 'Embedding configuration saved (credentials not tested).');
  p.log.info('Restart the daemon to apply. Provider, model, or endpoint changes automatically rebuild the memory index. Use vargos memory reindex to rebuild manually.');
  if (provider === 'ollama') p.log.info(`Make sure Ollama is running and the embedding model is installed: ollama pull ${model}`);
}
