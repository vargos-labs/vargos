/**
 * Daemon entry. Builds the bus, loads services from disk via the loader (so reload
 * picks up new code), registers lifecycle methods, starts the JSON-RPC surface, and
 * signals readiness. The supervisor (index.ts) respawns this on RESTART_EXIT_CODE.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EmitterBus } from './core/bus.js';
import { ServiceLoader } from './core/loader.js';
import { discoverServices } from './core/services.js';
import { discoverEdgeServices } from './core/edges.js';
import { startRpcServer } from './core/rpc-server.js';
import { createLogger } from './lib/logger.js';
import { permissionHint } from './lib/error.js';
import { getDataPaths } from './lib/paths.js';
import { seedDataDir } from './lib/templates.js';
import { runMigrations } from './lib/migrate.js';
import { reportProblems } from './scripts/doctors/index.js';
import type { AppConfig } from './services/config/index.js';

const RESTART_EXIT_CODE = 42;
const log = createLogger('boot');

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const specs = await discoverServices(here, ext);

const bus = new EmitterBus();
const loader = new ServiceLoader(bus);
let rpcStop: (() => Promise<void>) | undefined;

const drain = async () => {
  await loader.disposeAll();
  if (rpcStop) await rpcStop();
};

// ── Lifecycle methods (need the loader) ─────────────────────────────────────────

bus.register('bus.restart', {
  description: 'Reload one service from disk in-process (same PID). Picks up new code after a git pull without killing the process; other services keep running.',
  schema: z.object({ service: z.string().describe('Service name, e.g. "channel", "memory", "agent"') }),
  cli: { positional: ['service'] },
}, async (p: { service: string }) => {
  await loader.restart(p.service);
  return { ok: true };
});

bus.register('bus.status', {
  description: 'List loaded services.',
  schema: z.object({}),
}, () => ({ services: loader.names().map(name => ({ name, status: 'running' as const })) }));

bus.register('bus.restartProcess', {
  description: 'Restart the whole process via the supervisor — reloads all services and transitive deps from disk. Returns immediately; teardown runs after the response is sent.',
  schema: z.object({}),
}, () => {
  setImmediate(async () => {
    log.info('process restart requested — draining and exiting');
    await drain();
    process.exit(RESTART_EXIT_CODE);
  });
  return { ok: true };
});

// ── Boot sequence ───────────────────────────────────────────────────────────────

try {
  await seedDataDir(log);
} catch (err) {
  // Unwritable data dir: name the cause + the fix rather than dying on a raw stack.
  const hint = permissionHint(err, getDataPaths().dataDir);
  if (!hint) throw err;
  log.error(hint);
  process.exit(1);
}
await runMigrations(log);
await reportProblems(log); // advisory only — a missing prerequisite must never block boot

for (const spec of specs) {
  try {
    await loader.load(spec);
  } catch (err) {
    log.error(`❌ failed to load ${spec.name}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// ── Edge services (external protocol bridges) ───────────────────────────────────
// Loaded after core services so the bus is fully wired. Failures are warnings.
const edgeSpecs = await discoverEdgeServices(here, ext);
if (edgeSpecs.length > 0) {
  log.info(`loading ${edgeSpecs.length} edge service(s): ${edgeSpecs.map(s => s.name).join(', ')}`);
}

for (const spec of edgeSpecs) {
  try {
    await loader.load(spec);
  } catch (err) {
    log.warn(`⚠️  edge service ${spec.name} failed to load: ${err instanceof Error ? err.message : String(err)}`);
  }
}
if (edgeSpecs.length > 0) {
  log.info('edge services loaded');
}

const config = await bus.call<AppConfig>('config.get', {});
const host = config.gateway.host ?? process.env.BUS_HOST ?? '127.0.0.1';
const port = parseInt(config.gateway.port ? String(config.gateway.port) : (process.env.BUS_PORT || '9000'), 10);

try {
  const timeoutMinutes = config.gateway.requestTimeoutMs / 1000 / 60; // 600000 ms = 10 minutes
  log.info(`Starting RPC server on ${host}:${port} with timeout ${timeoutMinutes} minutes...`);
  rpcStop = await startRpcServer(bus, host, port, config.gateway.requestTimeoutMs);
} catch (err) {
  log.error(`failed to start RPC server: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

bus.emit('bus.onReady', {});
const allLoaded = [...specs.map(s => s.name), ...loader.names().filter(n => !specs.some(s => s.name === n))];
log.info(`✅ ${allLoaded.length} services ready: ${allLoaded.join(', ')}`);

// ── Process-level handlers ──────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  // undici "other side closed" and similar stream teardown noise must not crash the daemon.
  log.error(`uncaughtException: ${err.stack ?? err.message ?? err}`);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return; // a second signal must not re-enter drain()
  shuttingDown = true;
  log.info('shutting down');
  // Bound the drain: a wedged dispose() or a lingering RPC socket must never
  // hold the process past this — systemd/`vargos start` expect a prompt exit.
  const force = setTimeout(() => {
    log.warn('shutdown timed out after 5s — forcing exit');
    process.exit(0);
  }, 5000);
  force.unref();
  try {
    await drain();
  } catch (err) {
    log.error(`drain failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  clearTimeout(force);
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
