/**
 * 002 — retire the `pi-mcp-adapter`.
 *
 * Before Pi 0.99 the interactive CLI needed a third-party adapter (`pi-mcp-adapter`) to reach
 * MCP servers. Pi 0.99 ships `builtin:mcp`, enabled by default, reading the same
 * `agent/mcp.json` — with the richer `exposure`/`toolExposure` model, codemode + tool_search
 * integration, resources, and OAuth. An installed adapter that registers MCP *replaces* that
 * built-in support (Pi `docs/mcp.md`), so keeping it duplicates every server.
 *
 * Vargos no longer installs the adapter (see `cli/chat.ts`). This cleans up what an existing
 * install still carries:
 *   1. `"packages": ["npm:pi-mcp-adapter"]` in `agent/settings.json`
 *   2. the adapter-only `directTools` key on each server in `agent/mcp.json`, translated to
 *      the built-in equivalent:
 *        `true`            -> `exposure: "direct"`
 *        `["tool", ...]`   -> `toolExposure.<tool> = "direct"` (server default kept)
 *        `false` / other   -> dropped (built-in default exposure applies)
 * An `exposure` already set on the server is never overwritten.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Migration } from '../lib/migrate.js';
import { readJson, writeJson } from '../lib/util.js';

const MCP_ADAPTER_SPEC = 'npm:pi-mcp-adapter';

interface McpServer {
  directTools?: unknown;
  exposure?: string;
  toolExposure?: Record<string, string>;
  [key: string]: unknown;
}

function isAdapterSpec(pkg: unknown): boolean {
  return typeof pkg === 'string' && (pkg === MCP_ADAPTER_SPEC || pkg.startsWith(`${MCP_ADAPTER_SPEC}@`));
}

/** Translate one server's adapter-only `directTools` into built-in exposure keys. */
function migrateServer(server: McpServer): boolean {
  if (!Object.prototype.hasOwnProperty.call(server, 'directTools')) return false;

  const directTools = server.directTools;
  delete server.directTools;

  if (directTools === true) {
    if (server.exposure === undefined) server.exposure = 'direct';
  } else if (Array.isArray(directTools) && directTools.length > 0) {
    const toolExposure = (server.toolExposure ??= {});
    for (const name of directTools) {
      if (typeof name === 'string' && toolExposure[name] === undefined) toolExposure[name] = 'direct';
    }
  }
  return true;
}

const migration: Migration = {
  id: '002-remove-mcp-adapter',
  description: 'Remove the obsolete pi-mcp-adapter and migrate directTools to exposure',
  async run({ paths, log }) {
    const settingsFile = path.join(paths.agentDir, 'settings.json');
    const settings = readJson<{ packages?: unknown[] }>(settingsFile);
    if (settings?.packages?.some(isAdapterSpec)) {
      settings.packages = settings.packages.filter((pkg) => !isAdapterSpec(pkg));
      writeJson(settingsFile, settings);
      log.info('removed pi-mcp-adapter from settings.json packages');
    }

    const mcpFile = path.join(paths.agentDir, 'mcp.json');
    if (!existsSync(mcpFile)) return;
    const mcp = readJson<{ mcpServers?: Record<string, McpServer> }>(mcpFile);
    const servers = mcp?.mcpServers;
    if (!servers) return;

    let changed = 0;
    for (const server of Object.values(servers)) {
      if (migrateServer(server)) changed++;
    }
    if (changed > 0) {
      writeJson(mcpFile, mcp);
      log.info(`migrated directTools -> exposure on ${changed} MCP server(s)`);
    }
  },
};

export default migration;
