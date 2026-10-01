import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MigrationContext } from '../../lib/migrate.js';
import type { DataPaths } from '../../lib/paths.js';
import { readJson, writeJson } from '../../lib/util.js';
import migration from '../002-remove-mcp-adapter.js';

const tmpDirs: string[] = [];

interface Fixture {
  agentDir: string;
  settingsFile: string;
  mcpFile: string;
}

function fixture(settings?: object, mcp?: object): Fixture {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'vargos-migration-002-'));
  tmpDirs.push(dataDir);
  const agentDir = path.join(dataDir, 'agent');
  const settingsFile = path.join(agentDir, 'settings.json');
  const mcpFile = path.join(agentDir, 'mcp.json');
  if (settings) writeJson(settingsFile, settings);
  if (mcp) writeJson(mcpFile, mcp);
  return { agentDir, settingsFile, mcpFile };
}

function ctx(agentDir: string): MigrationContext {
  return { paths: { agentDir } as DataPaths, log: { info: () => {}, warn: () => {} } };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('migration 002 — remove pi-mcp-adapter', () => {
  it('drops the adapter from settings packages and keeps the rest', async () => {
    const f = fixture({ packages: ['npm:pi-mcp-adapter', 'npm:pi-agents-talk-to-each-other'] });
    await migration.run(ctx(f.agentDir));
    expect(readJson<{ packages: string[] }>(f.settingsFile)?.packages).toEqual(['npm:pi-agents-talk-to-each-other']);
  });

  it('drops a versioned adapter spec too', async () => {
    const f = fixture({ packages: ['npm:pi-mcp-adapter@^4.0.0'] });
    await migration.run(ctx(f.agentDir));
    expect(readJson<{ packages: string[] }>(f.settingsFile)?.packages).toEqual([]);
  });

  it('maps directTools: true to exposure: "direct" and removes the key', async () => {
    const f = fixture({}, { mcpServers: { context7: { command: 'npx', directTools: true } } });
    await migration.run(ctx(f.agentDir));
    const server = readJson<{ mcpServers: Record<string, Record<string, unknown>> }>(f.mcpFile)!.mcpServers.context7;
    expect(server.exposure).toBe('direct');
    expect('directTools' in server).toBe(false);
  });

  it('maps an array to per-tool toolExposure and leaves the server default alone', async () => {
    const f = fixture({}, { mcpServers: { gh: { directTools: ['search_code', 'get_issue'] } } });
    await migration.run(ctx(f.agentDir));
    const server = readJson<{ mcpServers: Record<string, Record<string, unknown>> }>(f.mcpFile)!.mcpServers.gh;
    expect(server.exposure).toBeUndefined();
    expect(server.toolExposure).toEqual({ search_code: 'direct', get_issue: 'direct' });
    expect('directTools' in server).toBe(false);
  });

  it('drops directTools: false without inventing an exposure', async () => {
    const f = fixture({}, { mcpServers: { x: { directTools: false } } });
    await migration.run(ctx(f.agentDir));
    const server = readJson<{ mcpServers: Record<string, Record<string, unknown>> }>(f.mcpFile)!.mcpServers.x;
    expect('directTools' in server).toBe(false);
    expect(server.exposure).toBeUndefined();
  });

  it('never overwrites an explicit exposure', async () => {
    const f = fixture({}, { mcpServers: { x: { directTools: true, exposure: 'deferred' } } });
    await migration.run(ctx(f.agentDir));
    const server = readJson<{ mcpServers: Record<string, Record<string, unknown>> }>(f.mcpFile)!.mcpServers.x;
    expect(server.exposure).toBe('deferred');
  });

  it('leaves servers with no directTools untouched', async () => {
    const f = fixture({}, { mcpServers: { resend: { command: 'npx', enabled: true } } });
    await migration.run(ctx(f.agentDir));
    expect(readJson<{ mcpServers: Record<string, unknown> }>(f.mcpFile)?.mcpServers.resend).toEqual({
      command: 'npx',
      enabled: true,
    });
  });

  it('is a no-op without settings.json or mcp.json and is idempotent', async () => {
    const f = fixture();
    await expect(migration.run(ctx(f.agentDir))).resolves.toBeUndefined();

    const g = fixture({ packages: ['npm:pi-mcp-adapter'] }, { mcpServers: { x: { directTools: true } } });
    await migration.run(ctx(g.agentDir));
    await expect(migration.run(ctx(g.agentDir))).resolves.toBeUndefined();
    const server = readJson<{ mcpServers: Record<string, Record<string, unknown>> }>(g.mcpFile)!.mcpServers.x;
    expect(server.exposure).toBe('direct');
  });
});
