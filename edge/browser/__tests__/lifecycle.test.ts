import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserEdge } from '../index.js';
import type { Bus } from '../../../core/types.js';

const dirs: string[] = [];
const edges: BrowserEdge[] = [];
function script(source: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vargos-dashboard-'));
  dirs.push(dir);
  const file = path.join(dir, 'dashboard.cjs');
  writeFileSync(file, source);
  return file;
}
async function start(file?: string, enabled = true, connected = true) {
  vi.stubEnv('VARGOS_CLI_ONESHOT', '');
  vi.stubEnv('VARGOS_BROWSER_SCRIPT', file ?? '');
  vi.stubEnv('VARGOS_DASHBOARD_PORT', '19005');
  const edge = new BrowserEdge();
  edges.push(edge);
  let status!: () => { running: boolean; pid: number | null };
  await edge.init({ call: async () => [{ name: 'playwright', enabled, connected }], register: (_name, _opts, handler) => { status = handler as typeof status; } } as Bus);
  return { edge, status };
}

afterEach(async () => {
  await Promise.all(edges.splice(0).map(edge => edge.dispose()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('browser dashboard lifecycle', () => {
  it('stays disabled when no script is configured', async () => {
    const { status } = await start();
    expect(status().running).toBe(false);
    expect(status().pid).toBeNull();
  });

  it.each([[false, true], [true, false]])('skips disabled or disconnected MCP (%s, %s)', async (enabled, connected) => {
    const { status } = await start(script("throw new Error('must not start');"), enabled, connected);
    expect(status().running).toBe(false);
    expect(status().pid).toBeNull();
  });

  it('reaps its child and can start again', async () => {
    const file = script("console.log('Listening on http://127.0.0.1:19005'); setInterval(() => {}, 1000);");
    const first = await start(file);
    expect(first.status().running).toBe(true);
    const pid = first.status().pid!;
    await first.edge.dispose();
    expect(first.status().running).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
    const second = await start(file);
    expect(second.status().running).toBe(true);
    expect(second.status().pid).not.toBe(pid);
  });

  it('does not claim an existing singleton as its own', async () => {
    const { status } = await start(script("console.log('Dashboard is running pid=123');"));
    expect(status().running).toBe(false);
    expect(status().pid).toBeNull();
  });

  it('disables cleanly when startup fails', async () => {
    const { status } = await start(script('process.exit(1);'));
    expect(status().running).toBe(false);
    expect(status().pid).toBeNull();
  });
});
