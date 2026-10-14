import type { AppConfig } from '../../config/index.js';

/**
 * Resolves a "provider:model" reference (e.g. "voicestudio:large-v3") against the
 * merged app config — auth key from `auth[provider]`, baseUrl from `providers[provider]`.
 *
 * Shared by the media, stt and tts services so every media-model reference resolves
 * the same way.
 */
export interface ResolvedModelRef {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export function resolveModelRef(config: AppConfig, ref: string): ResolvedModelRef {
  const [provider, model] = ref.split(':');
  if (!provider || !model) throw new Error(`Invalid model ref "${ref}" (expected "provider:model")`);
  const authEntry = config.auth?.[provider];
  const apiKey = authEntry && 'key' in authEntry ? authEntry.key : null;
  if (!apiKey) throw new Error(`No API key configured for provider "${provider}"`);
  return { provider, model, apiKey, baseUrl: config.providers?.[provider]?.baseUrl };
}
