import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import { configureMemory } from '../memory.js';
import { ConfigService, type AppConfig } from '../../services/config/index.js';
import { EmitterBus } from '../../core/bus.js';
import { resetDataPaths } from '../../lib/paths.js';

vi.mock('@clack/prompts', () => ({
  select: vi.fn(), password: vi.fn(), text: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
  log: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

describe('post-install memory configuration', () => {
  let dir: string;
  let original: string | undefined;
  const read = () => JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'));
  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(path.join(tmpdir(), 'vargos-memory-cli-'));
    original = process.env.VARGOS_DATA_DIR;
    process.env.VARGOS_DATA_DIR = dir;
    resetDataPaths();
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ channels: [{ id: 'keep-me', type: 'whatsapp' }] }));
  });
  afterEach(() => {
    if (original === undefined) delete process.env.VARGOS_DATA_DIR;
    else process.env.VARGOS_DATA_DIR = original;
    resetDataPaths();
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves OpenAI settings under memory and preserves unrelated configuration', async () => {
    vi.mocked(p.select).mockResolvedValue('openai');
    vi.mocked(p.password).mockResolvedValue('test-embedding-key');
    vi.mocked(p.text).mockResolvedValue('custom-embedding-model');
    await configureMemory();
    expect(read()).toMatchObject({
      channels: [{ id: 'keep-me' }],
      memory: { provider: 'openai', key: 'test-embedding-key', model: 'custom-embedding-model' },
    });
    expect(read().agent).toBeUndefined();
    expect(JSON.stringify(vi.mocked(p.log.success).mock.calls)).not.toContain('test-embedding-key');
  });

  it('switches legacy OpenAI settings to keyword without reactivating legacy credentials', async () => {
    mkdirSync(path.join(dir, 'agent'));
    writeFileSync(path.join(dir, 'agent/settings.json'), JSON.stringify({
      memoryEmbeddingProvider: 'openai', memoryEmbeddingApiKey: 'legacy-key',
    }));
    vi.mocked(p.select).mockResolvedValue('keyword');
    await configureMemory();
    expect(read().memory.provider).toBe('keyword');
    expect(read().memory.key).toBeUndefined();
    expect(p.password).not.toHaveBeenCalled();
  });

  it('loads the saved memory settings through the real config service and persists them at the root', async () => {
    vi.mocked(p.select).mockResolvedValue('openai');
    vi.mocked(p.password).mockResolvedValue('test-key');
    vi.mocked(p.text).mockResolvedValue('text-embedding-3-small');
    await configureMemory();
    const bus = new EmitterBus();
    const service = new ConfigService();
    service.init(bus);
    const loaded = await bus.call<AppConfig>('config.get', {});
    expect(loaded.memory).toMatchObject({ provider: 'openai', key: 'test-key' });
    await bus.call('config.set', loaded);
    expect(read().memory).toMatchObject({ provider: 'openai', key: 'test-key' });
    expect(read().agent).toBeUndefined();
    service.dispose();
  });

  it('configures Ollama without carrying over the OpenAI key or model', async () => {
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      memory: { provider: 'openai', key: 'private-openai-key', model: 'openai-model' },
    }));
    vi.mocked(p.select).mockResolvedValue('ollama');
    vi.mocked(p.text).mockResolvedValueOnce('http://localhost:11434').mockResolvedValueOnce('');
    await configureMemory();
    expect(read().memory).toMatchObject({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'embeddinggemma' });
    expect(read().memory.key).toBeUndefined();
    expect(p.password).not.toHaveBeenCalled();
  });

  it('keeps an existing key when the password prompt is left blank', async () => {
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      memory: { provider: 'openai', key: 'existing-key', model: 'existing-model' },
    }));
    vi.mocked(p.select).mockResolvedValue('openai');
    vi.mocked(p.password).mockResolvedValue('');
    vi.mocked(p.text).mockResolvedValue('');
    await configureMemory();
    expect(read().memory).toMatchObject({ key: 'existing-key', model: 'existing-model' });
  });

  it.each(['provider', 'key', 'model'])('does not write when cancelling at %s', async (step) => {
    const before = readFileSync(path.join(dir, 'config.json'), 'utf8');
    vi.mocked(p.select).mockResolvedValue(step === 'provider' ? Symbol('cancel') : 'openai');
    vi.mocked(p.password).mockResolvedValue(step === 'key' ? Symbol('cancel') : 'test-key');
    vi.mocked(p.text).mockResolvedValue(Symbol('cancel'));
    await configureMemory();
    expect(readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(before);
  });
});
