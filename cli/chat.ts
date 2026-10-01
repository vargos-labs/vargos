/**
 * `vargos chat` — launch the pi coding-agent CLI against the Vargos data dir.
 * Seeds templates, ensures the MCP adapter is installed, then hands off to pi.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { getDataPaths } from '../lib/paths.js';
import { createLogger } from '../lib/logger.js';
import { readJson } from '../lib/util.js';
import { seedDataDir } from '../lib/templates.js';
import { reportProblems } from '../scripts/doctors/index.js';
import { ensureMcpAdapter, resolvePiCli } from './mcp-adapter.js';

export async function chat(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const paths = getDataPaths();
  await seedDataDir(createLogger('seed'));

  const dataDir = paths.dataDir;
  const agentDir = path.join(dataDir, 'agent');
  const piCliPath = resolvePiCli(here);

  // Ensure the MCP adapter is installed to the Vargos agent directory *and* current —
  // a stale copy (e.g. 2.x under a newer Pi) breaks /mcp and prints warnings on every start.
  try {
    const settings = readJson<{ packages?: string[] }>(path.join(agentDir, 'settings.json')) ?? {};
    ensureMcpAdapter(agentDir, piCliPath, settings.packages ?? []);
  } catch { /* chat still works without MCP */ }

  // pi treats an MCP server that fails to spawn as fatal, so name the missing
  // prerequisite here rather than letting the session die on a bare ENOENT.
  await reportProblems(createLogger('doctor'));

  execSync(`node "${piCliPath}" --session-dir "${dataDir}/sessions/cli"`, {
    stdio: 'inherit',
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, VARGOS_DATA_DIR: dataDir },
  });
}
