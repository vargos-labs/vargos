/**
 * pi-mcp-adapter lifecycle for the interactive `pi` CLI (`vargos chat` / `vargos config`).
 *
 * The adapter is a **Pi package**, not a Vargos dependency: it is installed into the agent
 * directory (via `pi install`) so the interactive CLI can reach MCP servers. The Vargos
 * daemon does not use it — `services/mcp` connects to the same `agent/mcp.json` and exposes
 * tools on the bus.
 *
 * The old guard only checked that the package was *listed* in `settings.json`, so a copy
 * pinned to an old major never upgraded. Adapter 2.x predates Pi's built-in MCP: it took
 * over `/mcp` (startup warning) and shipped Pi's host packages under `dependencies`
 * (npm peer-dependency warning). 4.0.0 fixed both by detecting `builtin:mcp` and moving
 * those to `peerDependencies`. Compare the installed major, never mere presence.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readJson } from '../lib/util.js';

export const MCP_ADAPTER_PACKAGE = 'pi-mcp-adapter';
export const MCP_ADAPTER_SPEC = `npm:${MCP_ADAPTER_PACKAGE}`;

/** Lowest adapter major that coexists with Pi 0.99 (see module doc). */
export const MIN_MCP_ADAPTER_MAJOR = 4;

export type AdapterState = 'current' | 'outdated' | 'missing';

/** Version from the copy installed under `<agentDir>/npm`, if any. */
export function installedAdapterVersion(agentDir: string): string | undefined {
  const pkg = path.join(agentDir, 'npm', 'node_modules', MCP_ADAPTER_PACKAGE, 'package.json');
  return readJson<{ version?: string }>(pkg)?.version;
}

export function adapterState(agentDir: string): AdapterState {
  const version = installedAdapterVersion(agentDir);
  if (!version) return 'missing';
  const major = Number.parseInt(version, 10);
  return Number.isFinite(major) && major >= MIN_MCP_ADAPTER_MAJOR ? 'current' : 'outdated';
}

/** Whether `settings.json` declares the adapter (`npm:pi-mcp-adapter`, bare or versioned). */
export function hasAdapterPackage(packages: string[] = []): boolean {
  return packages.some((p) => p === MCP_ADAPTER_SPEC || p.startsWith(`${MCP_ADAPTER_SPEC}@`));
}

/**
 * The `pi` command needed to reach a working adapter, or `undefined` when it is already
 * configured and current. `update --extensions` reconciles an existing (stale) install;
 * `install` adds a missing one.
 */
export function adapterCommand(env: { agentDir: string; packages?: string[] }): string | undefined {
  const state = adapterState(env.agentDir);
  const listed = hasAdapterPackage(env.packages);
  if (state === 'current' && listed) return undefined;
  return state === 'outdated' && listed ? 'update --extensions' : `install ${MCP_ADAPTER_SPEC}`;
}

export type CommandRunner = (command: string, env: NodeJS.ProcessEnv) => void;

const defaultRunner: CommandRunner = (command, env) => {
  execSync(command, { stdio: 'pipe', env });
};

/**
 * Install/upgrade the adapter if needed and return a human-readable result. Best-effort:
 * callers treat a throw as "chat still works, just without MCP".
 */
export function ensureMcpAdapter(
  agentDir: string,
  piCliPath: string,
  packages: string[] = [],
  run: CommandRunner = defaultRunner,
): string {
  const command = adapterCommand({ agentDir, packages });
  if (!command) return 'MCP adapter ready.';
  run(`node "${piCliPath}" ${command}`, { ...process.env, PI_CODING_AGENT_DIR: agentDir });
  return command.startsWith('update') ? 'MCP adapter updated.' : 'MCP adapter installed.';
}

/** Locate the bundled pi CLI (falls back to `pi` on PATH for global installs). */
export function resolvePiCli(startDir: string): string {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return 'pi';
}
