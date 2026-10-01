// Vargos entrypoint — a tiny supervisor.
// Spawns boot.ts (or boot.js in prod) as a child process and respawns it when
// it exits with RESTART_EXIT_CODE (42). bus.restart triggers that exit code
// after draining stoppers; other exit codes pass through.
//
// Why a separate process: a fresh Node process re-reads all code from disk,
// so `git pull && bus.restart` reliably picks up source AND transitive deps.
// In-process restart can't do that (ESM module cache + shared lib state).

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createLogger } from './lib/logger.js';
import { resolveTsxCommand } from './lib/tsx-command.js';

const RESTART_EXIT_CODE = 42;
const RESPAWN_DELAY_MS = 500;
const log = createLogger('supervisor');

const here = dirname(fileURLToPath(import.meta.url));
const isDev = import.meta.url.endsWith('.ts');
// Resolve tsx to the repo-local binary when present — the caller's PATH may omit
// node_modules/.bin (systemd units ship a minimal PATH), in which case spawning
// bare `tsx` fails with ENOENT. Falls back to PATH for other layouts.
const command = isDev ? resolveTsxCommand(here) : process.execPath;
const args = isDev
  ? [join(here, 'boot.ts')]
  : ['--enable-source-maps', join(here, 'boot.js')];

let child: ChildProcess | null = null;
let shuttingDown = false;

function spawnBoot(): void {
  child = spawn(command, args, { stdio: 'inherit', cwd: here });
  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      process.exit(code ?? (signal ? 1 : 0));
      return;
    }
    if (code === RESTART_EXIT_CODE) {
      log.info('restart requested; respawning boot');
      setTimeout(spawnBoot, RESPAWN_DELAY_MS);
    } else {
      process.exit(code ?? (signal ? 1 : 0));
    }
  });
}

function forward(sig: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!child || child.killed) { process.exit(0); return; }
  child.kill(sig);
  // boot.ts bounds its own drain to 5s; if the child is truly wedged past that,
  // SIGKILL it and leave — never let systemd fall through to TimeoutStopSec.
  const hard = setTimeout(() => {
    if (child && !child.killed) {
      log.warn('child did not exit after SIGTERM — sending SIGKILL');
      child.kill('SIGKILL');
    }
    process.exit(0);
  }, 8000);
  hard.unref();
}

process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));

// Config gate. The interactive first-run journey lives in `vargos setup` (and is
// triggered by `vargos start` / bare `vargos` only when not ready) — never from
// here, so a normal restart just boots. This is the last-resort guard for the
// `pnpm start` / `node index.js` paths: refuse to boot a daemon that can't serve
// the agent, and say how to fix it. boot.ts still seeds + migrates on every boot.
const { isReady } = await import('./cli/ready.js');
if (!isReady()) {
  process.stderr.write(
    '\n  ⚡ Vargos is not configured — run "vargos setup" first.\n' +
    '  (or set a provider key in the environment, e.g. ANTHROPIC_API_KEY)\n\n',
  );
  process.exit(1);
}

spawnBoot();