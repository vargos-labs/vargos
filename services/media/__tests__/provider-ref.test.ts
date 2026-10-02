import { describe, it, expect } from 'vitest';
import { resolveModelRef } from '../providers/provider-ref.js';
import type { AppConfig } from '../../config/index.js';

const config = {
  auth: {
    openai: { type: 'api_key', key: 'sk-test' },
    voicestudio: { type: 'api_key', key: 'vs-key' },
  },
  providers: {
    voicestudio: { baseUrl: 'http://192.168.88.109:3900' },
  },
} as unknown as AppConfig;

describe('resolveModelRef', () => {
  it('resolves provider, model, key and baseUrl', () => {
    expect(resolveModelRef(config, 'voicestudio:large-v3')).toEqual({
      provider: 'voicestudio',
      model: 'large-v3',
      apiKey: 'vs-key',
      baseUrl: 'http://192.168.88.109:3900',
    });
  });

  it('resolves a provider without a registered baseUrl (undefined, not null)', () => {
    expect(resolveModelRef(config, 'openai:whisper-1').baseUrl).toBeUndefined();
  });

  it('throws on a ref without provider:model shape', () => {
    expect(() => resolveModelRef(config, 'nomodel')).toThrow('Invalid model ref');
    expect(() => resolveModelRef(config, ':model')).toThrow('Invalid model ref');
  });

  it('throws when the provider has no auth key', () => {
    expect(() => resolveModelRef(config, 'missing:model')).toThrow('No API key configured for provider "missing"');
  });
});
