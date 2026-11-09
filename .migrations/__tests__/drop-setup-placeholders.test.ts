import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MigrationContext } from '../../lib/migrate.js';
import type { DataPaths } from '../../lib/paths.js';
import { readJson, writeJson } from '../../lib/util.js';
import migration from '../003-drop-setup-placeholders.js';

const tmpDirs: string[] = [];

const TEMPLATE = {
  id: 'telegram-vargos-template',
  type: 'telegram',
  enabled: true,
  botToken: 'xxxxxxxxxx:Xxxxxxxxxxxxx-Xxxxxxxxxxxxxxxxxxxxx',
};
const OLD_ANTHROPIC = { baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic', models: [{ id: 'claude-sonnet-4-20250514' }] };

function fixture(config?: object, models?: object): DataPaths {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'vargos-migration-003-'));
  tmpDirs.push(dataDir);
  const paths = {
    configFile: path.join(dataDir, 'config.json'),
    agentModelsFile: path.join(dataDir, 'agent', 'models.json'),
  } as DataPaths;
  if (config) writeJson(paths.configFile, config);
  if (models) writeJson(paths.agentModelsFile, models);
  return paths;
}

const ctx = (paths: DataPaths): MigrationContext => ({ paths, log: { info: () => {}, warn: () => {} } });

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('migration 003 — drop setup placeholders', () => {
  it('removes the untouched example channel and keeps real ones', async () => {
    const mine = { id: 'mybot', type: 'telegram', botToken: '123:abc' };
    const paths = fixture({ gateway: {}, channels: [TEMPLATE, mine] });

    await migration.run(ctx(paths));

    expect(readJson<{ channels: unknown[] }>(paths.configFile)!.channels).toEqual([mine]);
  });

  it('keeps the example channel once the user put a real token in it', async () => {
    const adopted = { ...TEMPLATE, botToken: '999:real' };
    const paths = fixture({ channels: [adopted] });

    await migration.run(ctx(paths));

    expect(readJson<{ channels: unknown[] }>(paths.configFile)!.channels).toEqual([adopted]);
  });

  it('removes the old wizard anthropic entry so Pi built-ins apply', async () => {
    const local = { baseUrl: 'http://localhost:11434/v1', api: 'openai-completions' };
    const paths = fixture(undefined, { providers: { anthropic: OLD_ANTHROPIC, ollama: local } });

    await migration.run(ctx(paths));

    expect(readJson<{ providers: object }>(paths.agentModelsFile)!.providers).toEqual({ ollama: local });
  });

  it('repairs, rather than deletes, a customised entry using the invalid api id', async () => {
    const proxy = { baseUrl: 'https://proxy.example.com/v1', api: 'anthropic', apiKey: 'k' };
    const paths = fixture(undefined, { providers: { 'my-proxy': proxy } });

    await migration.run(ctx(paths));

    expect(readJson<{ providers: Record<string, object> }>(paths.agentModelsFile)!.providers['my-proxy'])
      .toEqual({ baseUrl: 'https://proxy.example.com', api: 'anthropic-messages', apiKey: 'k' });
  });

  it('is a no-op on a clean install', async () => {
    const paths = fixture({ channels: [] });

    await expect(migration.run(ctx(paths))).resolves.toBeUndefined();
    expect(readJson<{ channels: unknown[] }>(paths.configFile)!.channels).toEqual([]);
  });
});
