/**
 * LLM provider configuration — the one required piece of first-run setup.
 *
 * Writes the files services/config + the agent read: agent/auth.json (credentials),
 * agent/settings.json (defaultProvider + defaultModel), and — only for a local /
 * OpenAI-compatible endpoint — agent/models.json. The caller never sees three files —
 * one Q&A fills all of them.
 *
 * Hosted providers come from Pi SDK's built-in catalog (API type, base URL, model list),
 * so nothing here can drift from what the daemon actually runs. Before saving, one tiny
 * test request goes through the same Pi model runtime the agent uses — setup only says
 * "ready" once a real reply came back (or the user explicitly chose to skip the check).
 *
 * Shared by the first-run journey (cli/ready.ts) and `vargos config` (cli/config-menu.ts).
 */

import { existsSync } from 'node:fs';
import * as p from '@clack/prompts';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { getDataPaths } from '../lib/paths.js';
import { readJson, writeJson } from '../lib/util.js';
import { classifyError, sanitizeError, toMessage, type ErrorClass } from '../lib/error.js';

interface HostedProvider {
  label: string;
  /** Env var Pi SDK reads for this provider's key (see pi-ai env-api-keys). */
  envKey: string;
  /** Pre-selected model; falls back to the catalog when Pi no longer ships it. */
  recommended: string;
}

/** Hosted providers offered by the wizard. Everything else about them comes from Pi's catalog. */
export const HOSTED: Record<string, HostedProvider> = {
  anthropic: { label: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', recommended: 'claude-sonnet-5-5' },
  openai: { label: 'OpenAI', envKey: 'OPENAI_API_KEY', recommended: 'gpt-5.5' },
  google: { label: 'Google Gemini', envKey: 'GEMINI_API_KEY', recommended: 'gemini-3.5-flash' },
  openrouter: { label: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', recommended: 'anthropic/claude-sonnet-5' },
  xai: { label: 'xAI', envKey: 'XAI_API_KEY', recommended: 'grok-4.7' },
  mistral: { label: 'Mistral', envKey: 'MISTRAL_API_KEY', recommended: 'mistral-large-latest' },
  deepseek: { label: 'DeepSeek', envKey: 'DEEPSEEK_API_KEY', recommended: 'deepseek-v4-pro' },
  groq: { label: 'Groq', envKey: 'GROQ_API_KEY', recommended: 'openai/gpt-oss-120b' },
};

/** Plain-language lead-in for a failed test request; the provider's own message follows. */
const FAILURE_REASON: Partial<Record<ErrorClass, string>> = {
  auth: 'The provider rejected the API key.',
  rate_limit: 'Rate-limited or out of credit on this account.',
  timeout: 'No reply in time — check your network or the endpoint URL.',
  transient: "Couldn't reach the provider — check your network or the endpoint URL.",
  capability: "This model isn't available to your account.",
};

const LOCAL = '__local__';
const LOCAL_DEFAULT_URL = 'http://localhost:11434/v1';
const TEST_TIMEOUT_MS = 30_000;

interface ModelsFile {
  providers?: Record<
    string,
    { baseUrl?: string; api?: string; apiKey?: string; models?: Array<{ id: string; name?: string }> }
  >;
}
interface SettingsFile {
  defaultProvider?: string;
  defaultModel?: string;
}

function agentFiles() {
  const { agentAuthFile, agentModelsFile, agentSettingsFile } = getDataPaths();
  return { auth: agentAuthFile, models: agentModelsFile, settings: agentSettingsFile };
}

/** The hosted provider whose key is already in the environment, if any. */
export function envProvider(): string | undefined {
  return Object.keys(HOSTED).find(id => process.env[HOSTED[id].envKey]);
}

/**
 * Cheap, side-effect free: does `~/.vargos/agent/` name a default provider + model
 * that could actually run? Deliberately permissive — the setup check (`testModel`) and
 * the daemon do the real validation. It only needs to be sure the setup journey isn't
 * sending a working install back through the wizard.
 */
export function providerReady(): boolean {
  const { configFile } = getDataPaths();
  if (!existsSync(configFile)) return false;

  const files = agentFiles();
  const settings = readJson<SettingsFile>(files.settings);
  const provider = settings?.defaultProvider;
  if (!provider || !settings?.defaultModel) return false;

  // Credentials can live in three places: inline in models.json, auth.json, or the env.
  const entry = readJson<ModelsFile>(files.models)?.providers?.[provider];
  if (entry?.apiKey) return true;
  if (readJson<Record<string, unknown>>(files.auth)?.[provider]) return true;
  if (HOSTED[provider] && process.env[HOSTED[provider].envKey]) return true;

  // A provider the user declared in models.json (local endpoints often need no key).
  return !!entry;
}

/** Pi's model runtime over this data dir — the exact object the agent service builds. */
async function loadRuntime(): Promise<ModelRuntime> {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const files = agentFiles();
  return ModelRuntime.create({ authPath: files.auth, modelsPath: files.models });
}

/**
 * Send one tiny request through Pi with the saved config. Null on success, otherwise a
 * short, key-free reason to show the user.
 */
export async function testModel(provider: string, modelId: string): Promise<string | null> {
  try {
    const runtime = await loadRuntime();
    const model = runtime.getModel(provider, modelId);
    if (!model) return `"${provider}/${modelId}" is not a known model`;

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no reply within ${TEST_TIMEOUT_MS / 1000}s`)), TEST_TIMEOUT_MS);
    });
    const reply = await Promise.race([
      runtime.completeSimple(
        model,
        { messages: [{ role: 'user', content: 'Reply with the single word OK.', timestamp: Date.now() }] },
        { maxTokens: 64 },
      ),
      timeout,
    ]).finally(() => clearTimeout(timer));

    return reply.stopReason === 'error' ? sanitizeError(reply.errorMessage ?? 'unknown error') : null;
  } catch (err) {
    return sanitizeError(toMessage(err));
  }
}

function unwrap<T>(v: T | symbol): T {
  if (p.isCancel(v)) {
    p.cancel('Setup cancelled — run "vargos setup" to resume.');
    process.exit(0);
  }
  return v as T;
}

function saveAuth(provider: string, key: string): void {
  const file = agentFiles().auth;
  const auth = readJson<Record<string, unknown>>(file) ?? {};
  auth[provider] = { type: 'api_key', key };
  writeJson(file, auth);
}

function saveDefault(provider: string, model: string): void {
  const { configFile } = getDataPaths();
  if (!existsSync(configFile)) writeJson(configFile, { gateway: {} });
  const file = agentFiles().settings;
  const settings = readJson<SettingsFile>(file) ?? {};
  settings.defaultProvider = provider;
  settings.defaultModel = model;
  writeJson(file, settings);
}

/** Catalog models for a provider — recommended first, newest-looking next. */
async function catalogModels(provider: string): Promise<string[]> {
  const ids = (await loadRuntime()).getModels().filter(m => m.provider === provider).map(m => m.id).reverse();
  const rec = HOSTED[provider]?.recommended;
  return rec && ids.includes(rec) ? [rec, ...ids.filter(id => id !== rec)] : ids;
}

async function pickModel(ids: string[], current?: string): Promise<string> {
  const OTHER = '__other__';
  const choice = ids.length
    ? unwrap(await p.autocomplete({
      message: 'Default model (type to filter)',
      options: [...ids.map(id => ({ value: id, label: id })), { value: OTHER, label: 'Other — type a model ID' }],
      initialValue: current && ids.includes(current) ? current : ids[0],
      maxItems: 8,
    })) as string
    : OTHER;
  if (choice !== OTHER) return choice;
  return unwrap(await p.text({
    message: 'Model ID',
    placeholder: 'e.g. llama3.2',
    validate: v => (v ? undefined : 'Required'),
  })) as string;
}

/** Run the test request behind a spinner; on failure, ask what to change ('ok' = save anyway). */
async function verify(provider: string, model: string): Promise<'ok' | 'key' | 'model'> {
  const spin = p.spinner();
  spin.start(`Testing ${provider} · ${model}`);
  const failure = await testModel(provider, model);
  if (!failure) {
    spin.stop(`${provider} · ${model} — replied`);
    return 'ok';
  }
  spin.error(`${provider} · ${model} — test request failed`);
  const reason = FAILURE_REASON[classifyError(failure)];
  p.log.error(reason ? `${reason}\n${failure}` : failure);

  return unwrap(await p.select({
    message: 'What now?',
    options: [
      { value: 'key', label: 'Re-enter the API key / endpoint' },
      { value: 'model', label: 'Pick a different model' },
      { value: 'ok', label: 'Save it anyway', hint: 'e.g. offline right now' },
    ],
  })) as 'ok' | 'key' | 'model';
}

async function configureHosted(provider: string, currentModel?: string): Promise<string> {
  const { label, envKey } = HOSTED[provider];
  let askKey = true;
  for (;;) {
    if (askKey) {
      const fromEnv = process.env[envKey];
      if (fromEnv) p.log.info(`Using ${envKey} from the environment.`);
      const key = fromEnv ?? unwrap(await p.password({
        message: `${label} API key`,
        validate: v => (v ? undefined : 'Required'),
      })) as string;
      // Saved before the test so it runs on exactly what the daemon will read.
      saveAuth(provider, key);
    }
    const model = await pickModel(await catalogModels(provider), currentModel);
    const next = await verify(provider, model);
    if (next === 'ok') return model;
    // An env key can't be "re-entered" here — say where it comes from instead of looping on it.
    if (next === 'key' && process.env[envKey]) {
      p.log.warn(`The key comes from ${envKey} — fix or unset it, then run "vargos setup" again.`);
      process.exit(1);
    }
    askKey = next === 'key';
  }
}

/** List model IDs from an OpenAI-compatible `/models` endpoint. */
async function listRemoteModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${baseUrl}/models`);
  const body = await res.json() as { data?: Array<{ id: string }> };
  return (body.data ?? []).map(m => m.id);
}

async function configureLocal(): Promise<{ provider: string; model: string }> {
  for (;;) {
    const provider = unwrap(await p.text({
      message: 'Name for this endpoint',
      placeholder: 'ollama',
      defaultValue: 'ollama',
      validate: v => (!v || /^[a-z0-9_-]+$/.test(v) ? undefined : 'lowercase letters, numbers, - and _ only'),
    })) as string;
    const baseUrl = unwrap(await p.text({
      message: 'Base URL (OpenAI-compatible, usually ends in /v1)',
      placeholder: LOCAL_DEFAULT_URL,
      defaultValue: LOCAL_DEFAULT_URL,
    })) as string;
    const apiKey = unwrap(await p.password({ message: 'API key (Enter to skip if none)' })) as string || undefined;

    let ids: string[] = [];
    try {
      ids = await listRemoteModels(baseUrl, apiKey);
    } catch (err) {
      p.log.warn(`Couldn't list models at ${baseUrl}: ${sanitizeError(toMessage(err))}`);
    }

    for (;;) {
      const model = await pickModel(ids);
      const file = agentFiles().models;
      const models = readJson<ModelsFile>(file) ?? {};
      models.providers = {
        ...models.providers,
        [provider]: {
          baseUrl,
          api: 'openai-completions',
          // Pi treats a provider without any key as "not configured"; keyless local servers
          // ignore the Authorization header, so a placeholder satisfies both.
          apiKey: apiKey ?? 'local',
          models: (ids.length ? ids : [model]).map(id => ({ id, name: id })),
        },
      };
      writeJson(file, models);

      const next = await verify(provider, model);
      if (next === 'ok') return { provider, model };
      if (next === 'key') break; // back to name / URL / key
    }
  }
}

/**
 * Interactive provider setup. Returns the chosen provider + model once it answered a
 * test request (or the user explicitly saved it untested).
 */
export async function configureProvider(): Promise<{ provider: string; model: string }> {
  const current = readJson<SettingsFile>(agentFiles().settings);
  const fromEnv = envProvider();

  const choice = unwrap(await p.select({
    message: 'LLM provider',
    initialValue: current?.defaultProvider && HOSTED[current.defaultProvider] ? current.defaultProvider : fromEnv ?? 'anthropic',
    options: [
      ...Object.entries(HOSTED).map(([id, h]) => ({
        value: id,
        label: h.label,
        hint: process.env[h.envKey] ? `${h.envKey} found` : undefined,
      })),
      { value: LOCAL, label: 'Local / OpenAI-compatible', hint: 'Ollama, LM Studio, vLLM, llama.cpp…' },
    ],
  })) as string;

  const { provider, model } = choice === LOCAL
    ? await configureLocal()
    : { provider: choice, model: await configureHosted(choice, current?.defaultProvider === choice ? current.defaultModel : undefined) };

  saveDefault(provider, model);
  return { provider, model };
}

/**
 * Headless setup from an env key (docker, systemd): pick that provider's recommended
 * model, save, and test. Returns the failure reason, or null once it works. Undefined
 * when no known provider key is in the environment.
 */
export async function configureFromEnv(): Promise<string | null | undefined> {
  const provider = envProvider();
  if (!provider) return undefined;
  const [model] = await catalogModels(provider);
  if (!model) return `Pi SDK ships no models for "${provider}"`;
  saveAuth(provider, process.env[HOSTED[provider].envKey]!);
  const failure = await testModel(provider, model);
  if (failure) return `${provider} · ${model}: ${failure}`;
  // Only a working provider becomes the default — a failed test leaves the install "not ready".
  saveDefault(provider, model);
  return null;
}
