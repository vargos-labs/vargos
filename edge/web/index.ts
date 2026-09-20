/**
 * Web console edge service — `edge-web`.
 *
 * Brings the browser UI up as part of the daemon: `vargos start`, `npx
 * @vargos-labs/vargos`, and systemd all get it, no separate process to launch.
 *
 *   • Next server (HTTP + `/api/*`) — a child process on WEB_PORT (default 9003).
 *     Dev: `pnpm --filter @vargos-labs/vargos-web dev`. Prod: the standalone bundle
 *     staged into `dist/web/` by the root build.
 *   • Live-update WebSocket — in-process on VARGOS_WEB_WS_PORT (default 9004).
 *     Runs here (not in Next) so it reads gateway state straight off the bus and
 *     survives the Next child restarting.
 *
 * Callable: web.status
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { WebSocketServer, WebSocket } from 'ws';
import type { Bus, Service } from '../../core/types.js';
import type { AppConfig } from '../../services/config/index.js';
import { createLogger } from '../../lib/logger.js';
import { toMessage } from '../../lib/error.js';
import { getDataPaths } from '../../lib/paths.js';

const log = createLogger('edge-web');

const WEB_PORT = parseInt(process.env.WEB_PORT || '9003', 10);
const WS_PORT = parseInt(process.env.VARGOS_WEB_WS_PORT || '9004', 10);
const WEB_HOST = process.env.WEB_HOST || '0.0.0.0';
const POLL_MS = 30_000;
const DEBOUNCE_MS = 500;

// The ServiceLoader imports services with a cache-busting `?v=<ts>` query — parse
// it off before deriving paths / the dev flag.
const selfPath = decodeURIComponent(new URL(import.meta.url).pathname);
const here = path.dirname(selfPath);
const isDev = selfPath.endsWith('.ts');
/** repo root in dev (`<root>/edge/web`), package root in prod (`<pkg>/dist/edge/web`). */
const root = path.resolve(here, '..', '..');

type WsEvent =
  | { type: 'hello'; wsPort: number; dataDir: string }
  | { type: 'fs_change'; path: string; change: string; at: string }
  | { type: 'gateway_status'; payload: unknown; at: string };

export class WebEdge implements Service {
  readonly name = 'edge-web';

  private bus!: Bus;
  private child: ChildProcess | null = null;
  private childStops = false;
  private restarts = 0;
  private wss: WebSocketServer | null = null;
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounce = new Map<string, NodeJS.Timeout>();
  private lastStatusJson = '';
  private lastStatus: unknown = null;

  async init(bus: Bus): Promise<void> {
    this.bus = bus;

    bus.register('web.status', {
      description: 'Status of the web console: Next child + live-update WebSocket.',
      schema: z.object({}),
    }, () => ({
      http: { port: WEB_PORT, pid: this.child?.pid ?? null, running: !!this.child && !this.child.killed },
      ws: { port: WS_PORT, clients: this.wss?.clients.size ?? 0 },
      mode: isDev ? 'dev' : 'standalone',
    }));

    // One-shot CLI stacks (`vargos <service>`): no UI.
    if (process.env.VARGOS_CLI_ONESHOT) return;

    const gatewayPort = await this.resolveGatewayPort();
    this.startWs();
    this.spawnChild(gatewayPort);

    bus.on('bus.onReady', () => void this.poll());
    log.info(`web console on http://${WEB_HOST}:${WEB_PORT} · ws:${WS_PORT} (${isDev ? 'dev' : 'standalone'})`);
  }

  async dispose(): Promise<void> {
    this.childStops = true;
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.watcher?.close();
    this.wss?.close();
    await this.killChild();
  }

  // ── gateway port ─────────────────────────────────────────────────────────

  private async resolveGatewayPort(): Promise<number> {
    try {
      const cfg = await this.bus.call<AppConfig>('config.get', {});
      if (cfg.gateway?.port) return Number(cfg.gateway.port);
    } catch { /* not up yet — fall through */ }
    return parseInt(process.env.BUS_PORT || '9000', 10);
  }

  // ── Next child ───────────────────────────────────────────────────────────

  private spawnChild(gatewayPort: number): void {
    const { dataDir } = getDataPaths();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(WEB_PORT),
      HOSTNAME: WEB_HOST,
      VARGOS_DATA_DIR: dataDir,
      VARGOS_GATEWAY_PORT: String(gatewayPort),
      VARGOS_WEB_WS_PORT: String(WS_PORT),
      NEXT_PUBLIC_VARGOS_WS_PORT: String(WS_PORT),
    };

    const server = path.join(root, 'web', 'web', 'server.js'); // dist/web/web/server.js
    if (!isDev && !fs.existsSync(server)) {
      log.warn(`standalone build missing at ${server} — UI disabled (run "pnpm build")`);
      return;
    }

    this.child = isDev
      ? spawn('pnpm', ['--filter', '@vargos-labs/vargos-web', 'dev'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(process.execPath, [server], { cwd: path.dirname(server), env, stdio: ['ignore', 'pipe', 'pipe'] });

    const tag = (line: string) => line.split('\n').filter(Boolean).forEach(l => log.info(`[next] ${l}`));
    this.child.stdout?.on('data', (b: Buffer) => tag(b.toString()));
    this.child.stderr?.on('data', (b: Buffer) => tag(b.toString()));

    this.child.on('exit', (code, signal) => {
      this.child = null;
      if (this.childStops) return;
      if (this.restarts >= 5) {
        log.error(`Next child exited (${code ?? signal}) — 5 restarts hit, giving up`);
        return;
      }
      const delay = Math.min(1000 * 2 ** this.restarts, 15_000);
      this.restarts++;
      log.warn(`Next child exited (${code ?? signal}) — restarting in ${delay}ms`);
      setTimeout(() => { if (!this.childStops) this.spawnChild(gatewayPort); }, delay);
    });
  }

  private killChild(): Promise<void> {
    const c = this.child;
    this.child = null;
    if (!c || c.killed) return Promise.resolve();
    return new Promise((resolve) => {
      const hard = setTimeout(() => { c.kill('SIGKILL'); resolve(); }, 3000);
      hard.unref();
      c.once('exit', () => { clearTimeout(hard); resolve(); });
      c.kill('SIGTERM');
    });
  }

  // ── live-update WebSocket ────────────────────────────────────────────────

  private startWs(): void {
    const wss = new WebSocketServer({ port: WS_PORT, host: WEB_HOST });
    this.wss = wss;
    wss.on('error', (err: NodeJS.ErrnoException) =>
      log.error(`ws server error: ${err.code === 'EADDRINUSE' ? `port ${WS_PORT} in use` : err.message}`));

    wss.on('connection', (ws: WebSocket) => {
      const { dataDir } = getDataPaths();
      ws.send(JSON.stringify({ type: 'hello', wsPort: WS_PORT, dataDir } satisfies WsEvent));
      if (this.lastStatus) {
        ws.send(JSON.stringify({ type: 'gateway_status', payload: this.lastStatus, at: new Date().toISOString() } satisfies WsEvent));
      }
    });

    // fs.watch the data dir (Node 20+ recursive).
    try {
      const { dataDir } = getDataPaths();
      this.watcher = fs.watch(dataDir, { recursive: true }, (event, filename) => {
        if (!filename) return;
        const name = filename.toString();
        const abs = path.isAbsolute(name) ? name : path.join(dataDir, name);
        const rel = path.relative(dataDir, abs);
        if (rel.startsWith('..')) return;
        const prev = this.debounce.get(rel);
        if (prev) clearTimeout(prev);
        this.debounce.set(rel, setTimeout(() => {
          this.debounce.delete(rel);
          this.broadcast({ type: 'fs_change', path: rel, change: String(event), at: new Date().toISOString() });
        }, DEBOUNCE_MS));
      });
    } catch (err) {
      log.warn(`fs.watch failed — live file updates disabled: ${toMessage(err)}`);
    }

    void this.poll();
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
    this.pollTimer.unref?.();
  }

  private broadcast(event: WsEvent): void {
    const msg = JSON.stringify(event);
    for (const c of this.wss?.clients ?? []) {
      if (c.readyState === WebSocket.OPEN) c.send(msg);
    }
  }

  private async poll(): Promise<void> {
    const safe = async <T>(m: string): Promise<T | null> => {
      try { return await this.bus.call<T>(m, {}); } catch { return null; }
    };
    const payload = {
      services: await safe('bus.status'),
      agent: await safe('agent.status'),
      memory: await safe('memory.stats'),
    };
    const json = JSON.stringify(payload);
    if (json === this.lastStatusJson) return;
    this.lastStatusJson = json;
    this.lastStatus = payload;
    this.broadcast({ type: 'gateway_status', payload, at: new Date().toISOString() });
  }
}

export function createService(): Service {
  return new WebEdge();
}
