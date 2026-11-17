/**
 * Webhooks edge service — inbound HTTP webhooks that trigger agent runs.
 *
 * Callable: webhook.list
 * Subscribes: agent.onCompleted (delivery to notify targets)
 *
 * Inbound flow: POST /hooks/:id → validate token → transform payload
 *   → (null/undefined/empty transform result skips) session create/addMessage
 *   → agent.execute → deliver to notify targets
 */

import { AgentOptionsSchema } from '../../services/config/schemas/agent.js';
import http from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import type { Bus, Service } from '../../core/types.js';
import type { AppConfig, WebhookEntry } from '../../services/config/index.js';
import { createLogger } from '../../lib/logger.js';
import { toMessage } from '../../lib/error.js';
import { getDataPaths } from '../../lib/paths.js';
import { webhookSessionKey, parseSessionKey } from '../../lib/session-key.js';
import { filterPaginate, ListSchema, type ListParams } from '../../lib/paginate.js';
import { loadTransform } from './transform.js';

const log = createLogger('webhooks');

const MAX_BODY = 1024 * 1024; // 1 MB
const HOOK_ID_RE = /^[a-z0-9_-]+$/i;
const HTTP_PORT = parseInt(process.env.WEBHOOKS_PORT || '9002', 10);
const HTTP_HOST = process.env.WEBHOOKS_HOST || '127.0.0.1';

// ── WebhooksEdge ──────────────────────────────────────────────────────────────

type AgentCompletedPayload = { sessionKey: string; success: boolean };

export class WebhooksEdge implements Service {
  readonly name = 'edge-webhooks';
  private hooks = new Map<string, WebhookEntry>();
  private activeHooks = new Set<string>();
  private server: http.Server | null = null;
  private bus!: Bus;

  async init(bus: Bus): Promise<void> {
    this.bus = bus;
    const config = await bus.call<AppConfig>('config.get', {});
    this.hooks = new Map(config.webhooks.map(h => [h.id, h]));
    for (const hook of this.hooks.values()) {
      if (!hook.token) {
        log.warn(`webhook ${hook.id} has no token configured — auth is bypassed; any client that can reach the port can fire it`);
      }
    }

    bus.register('webhook.list', {
      description: 'List registered webhook endpoints.',
      schema: ListSchema,
      cli: { positional: ['query'] },
    }, (p) => this.list(p));

    bus.on('agent.onCompleted', (p: AgentCompletedPayload) => this.onAgentCompleted(p));

    // One-shot CLI introspection (webhook.list) reads hooks from config — no HTTP needed.
    if (process.env.VARGOS_CLI_ONESHOT) return;
    await this.startHttp();
    log.info(`started with ${this.hooks.size} webhook(s) on ${HTTP_HOST}:${HTTP_PORT}`);
  }

  async dispose(): Promise<void> {
    await this.stopHttp();
  }

  // ── Callable handler ─────────────────────────────────────────────────────

  private list(params: ListParams) {
    // Strip tokens — never expose secrets
    const all: WebhookEntry[] = Array.from(this.hooks.values()).map(
      ({ id, name, transform, notify }) => ({ id, name, token: '', transform, notify }),
    );
    return filterPaginate(all, params, h => [h.id, h.name]);
  }

  // ── Agent completed handler ───────────────────────────────────────────────

  private onAgentCompleted(payload: AgentCompletedPayload): void {
    const parsed = parseSessionKey(payload.sessionKey);
    if (parsed.type !== 'webhook') return;
    // webhookSessionKey format: "webhook:<hookId>:<timestamp>"
    const hookId = parsed.id.replace(/:\d+$/, '');
    this.activeHooks.delete(hookId);
  }

  // ── HTTP server ───────────────────────────────────────────────────────────

  private startHttp(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.headersTimeout = 10_000;
      this.server.requestTimeout = 30_000;
      this.server.on('error', reject);
      this.server.listen(HTTP_PORT, HTTP_HOST, () => {
        log.info(`Webhooks HTTP is listening on ${HTTP_HOST}:${HTTP_PORT}`);
        resolve();
      });
    });
  }

  private stopHttp(): Promise<void> {
    const srv = this.server;
    if (!srv) return Promise.resolve();
    this.server = null;
    return new Promise(resolve => srv.close(() => resolve()));
  }

  // ── Request handling ──────────────────────────────────────────────────────

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || !req.url?.startsWith('/hooks/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const hookId = req.url.slice('/hooks/'.length).split('?')[0];
    if (!HOOK_ID_RE.test(hookId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid hook ID' }));
      return;
    }

    const hook = this.hooks.get(hookId);
    if (!hook) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown hook' }));
      return;
    }

    // No token configured for this hook → auth is bypassed entirely
    if (hook.token) {
      // Timing-safe comparison (hash prevents length leakage)
      const auth = req.headers.authorization ?? '';
      const expectedHash = createHash('sha256').update(`Bearer ${hook.token}`).digest();
      const authHash = createHash('sha256').update(auth).digest();
      if (!timingSafeEqual(authHash, expectedHash)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let destroyed = false;

    req.on('error', () => {
      if (!res.writableEnded) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request error' }));
      }
    });

    req.on('data', (chunk: Buffer) => {
      if (destroyed) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        destroyed = true;
        req.destroy();
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (res.writableEnded) return;
      // Respond immediately — fire and forget
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));

      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        payload = {};
      }

      this.fireHook(hook, payload).catch(err =>
        log.error(`fire hook ${hookId}: ${toMessage(err)}`),
      );
    });
  }

  // ── Fire ──────────────────────────────────────────────────────────────────

  private async fireHook(hook: WebhookEntry, payload: unknown): Promise<void> {
    const { dataDir } = getDataPaths();

    if ( typeof hook.transform !== 'string' || hook.transform.length === 0 ) {
      throw new Error(`Invalid transform for hook "${hook.id}". Expected a non-empty string — a relative path to a transform module in "${dataDir}" — got ${hook.transform === undefined ? 'undefined' : JSON.stringify(hook.transform)}`);
    }

    const transformOutput = await loadTransform(hook.transform, dataDir).then(fn => fn(payload));
    const sessionKey = webhookSessionKey(hook.id);

    let task = '',
      cwd = '';

    if (typeof transformOutput === 'string') {
      task = transformOutput;
    }
    else if (transformOutput && typeof transformOutput === 'object') {
      task = transformOutput.task ?? '';
      cwd = transformOutput.cwd ?? '';
    }

    // Transform returned null/undefined/empty string → intentional skip (dedup /
    // debounce / rate-limit); no agent run, no notify delivery.
    if (!task) {
      log.info(`skipped: ${hook.id} — transform returned no task`);
      return;
    }

    log.info(`fired: ${hook.id} → ${sessionKey}`);
    this.activeHooks.add(hook.id);

    // Only pass overrides when set: an empty `cwd` would flow through
    // `options?.cwd ?? dataDir` as "" ("" is not nullish) and the SDK would
    // resolve it to the daemon's process.cwd() instead of the data dir.
    const result = await this.bus.call<{ response: string }>('agent.execute', {
      sessionKey, task,
      ...(cwd && { cwd }),
      ...AgentOptionsSchema.parse(hook),
      ...(typeof transformOutput === 'object' && transformOutput ? AgentOptionsSchema.parse(transformOutput) : {}),
    });

    if (result.response && hook.notify?.length) {
      log.info(`${hook.id} delivering response to ${hook.notify.length} targets`);

      await Promise.all(hook.notify.map(target =>
        this.bus.call('channel.send', {
          sessionKey: target,
          text: result.response,
          fromSessionKey: sessionKey,
        }).catch(err => log.error(`notify send to ${target}: ${toMessage(err)}`)),
      ));
    }
  }
}

export function createService(): Service {
  return new WebhooksEdge();
}
