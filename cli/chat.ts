/**
 * `vargos chat` — launch the pi coding-agent CLI against the Vargos data dir.
 * Seeds templates, then hands off to pi. MCP comes from Pi's built-in `builtin:mcp`
 * extension, which reads the same `agent/mcp.json`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { getDataPaths } from '../lib/paths.js';
import { createLogger } from '../lib/logger.js';
import { seedDataDir } from '../lib/templates.js';
import { reportProblems } from '../scripts/doctors/index.js';
import { resolvePiCli } from './pi-cli.js';

export async function chat(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const paths = getDataPaths();
  await seedDataDir(createLogger('seed'));

  const dataDir = paths.dataDir;
  const agentDir = path.join(dataDir, 'agent');
  const piCliPath = resolvePiCli(here);

  // pi treats an MCP server that fails to spawn as fatal, so name the missing
  // prerequisite here rather than letting the session die on a bare ENOENT.
  await reportProblems(createLogger('doctor'));

  execSync(`node "${piCliPath}" --session-dir "${dataDir}/sessions/cli"`, {
    stdio: 'inherit',
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, VARGOS_DATA_DIR: dataDir },
  });
}
