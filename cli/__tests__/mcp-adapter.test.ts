import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  adapterCommand,
  adapterState,
  ensureMcpAdapter,
  hasAdapterPackage,
  installedAdapterVersion,
  MCP_ADAPTER_SPEC,
  resolvePiCli,
} from '../mcp-adapter.js';

const tmpDirs: string[] = [];

/** An agent dir, optionally with pi-mcp-adapter installed at `version`. */
function agentDir(version?: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vargos-mcp-adapter-'));
  tmpDirs.push(dir);
  if (version) {
    const pkgDir = path.join(dir, 'npm', 'node_modules', 'pi-mcp-adapter');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'pi-mcp-adapter', version }));
  }
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('installedAdapterVersion', () => {
  it('reads the version from the agent-dir install', () => {
    expect(installedAdapterVersion(agentDir('4.1.2'))).toBe('4.1.2');
  });

  it('returns undefined when the adapter is not installed', () => {
    expect(installedAdapterVersion(agentDir())).toBeUndefined();
  });
});

describe('adapterState', () => {
  it('is missing without an install', () => {
    expect(adapterState(agentDir())).toBe('missing');
  });

  it('flags the 2.x copy that predates Pi builtin:mcp as outdated', () => {
    expect(adapterState(agentDir('2.10.0'))).toBe('outdated');
  });

  it('accepts 4.x and newer', () => {
    expect(adapterState(agentDir('4.0.0'))).toBe('current');
    expect(adapterState(agentDir('5.1.0'))).toBe('current');
  });
});

describe('hasAdapterPackage', () => {
  it('matches the bare and versioned spec, ignoring unrelated packages', () => {
    expect(hasAdapterPackage([MCP_ADAPTER_SPEC])).toBe(true);
    expect(hasAdapterPackage(['npm:pi-mcp-adapter@^4.0.0'])).toBe(true);
    expect(hasAdapterPackage(['npm:something-else', './local'])).toBe(false);
    expect(hasAdapterPackage()).toBe(false);
  });
});

describe('adapterCommand', () => {
  it('does nothing when the adapter is listed and current', () => {
    expect(adapterCommand({ agentDir: agentDir('4.0.0'), packages: [MCP_ADAPTER_SPEC] })).toBeUndefined();
  });

  it('installs when the adapter was never configured', () => {
    expect(adapterCommand({ agentDir: agentDir(), packages: [] })).toBe(`install ${MCP_ADAPTER_SPEC}`);
  });

  it('updates a listed but outdated install (the bug: presence alone skipped this)', () => {
    expect(adapterCommand({ agentDir: agentDir('2.10.0'), packages: [MCP_ADAPTER_SPEC] })).toBe('update --extensions');
  });

  it('installs when the copy is present but not declared in settings', () => {
    expect(adapterCommand({ agentDir: agentDir('4.0.0'), packages: [] })).toBe(`install ${MCP_ADAPTER_SPEC}`);
  });
});

describe('ensureMcpAdapter', () => {
  it('skips the runner when already current', () => {
    const calls: string[] = [];
    const result = ensureMcpAdapter(agentDir('4.0.0'), '/pi/cli.js', [MCP_ADAPTER_SPEC], (cmd) => calls.push(cmd));
    expect(result).toBe('MCP adapter ready.');
    expect(calls).toEqual([]);
  });

  it('runs `update --extensions` for a stale install and points pi at the agent dir', () => {
    const calls: Array<{ cmd: string; env: NodeJS.ProcessEnv }> = [];
    const dir = agentDir('2.10.0');
    const result = ensureMcpAdapter(dir, '/pi/cli.js', [MCP_ADAPTER_SPEC], (cmd, env) => calls.push({ cmd, env }));
    expect(result).toBe('MCP adapter updated.');
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('node "/pi/cli.js" update --extensions');
    expect(calls[0].env.PI_CODING_AGENT_DIR).toBe(dir);
  });

  it('installs and reports when the adapter is absent', () => {
    const calls: string[] = [];
    const result = ensureMcpAdapter(agentDir(), '/pi/cli.js', [], (cmd) => calls.push(cmd));
    expect(result).toBe('MCP adapter installed.');
    expect(calls).toEqual([`node "/pi/cli.js" install ${MCP_ADAPTER_SPEC}`]);
  });
});

describe('resolvePiCli', () => {
  it('finds the bundled pi CLI by walking up from a nested dir', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vargos-pi-cli-'));
    tmpDirs.push(root);
    const nested = path.join(root, 'cli');
    const dist = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist');
    mkdirSync(nested, { recursive: true });
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, 'cli.js'), '// pi');
    expect(resolvePiCli(nested)).toBe(path.join(dist, 'cli.js'));
  });

  it('falls back to `pi` on PATH when not found', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vargos-pi-cli-'));
    tmpDirs.push(root);
    expect(resolvePiCli(root)).toBe('pi');
  });
});
