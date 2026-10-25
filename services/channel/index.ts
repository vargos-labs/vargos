/**
 * Channel service — manages external messaging adapters.
 *
 * Callable: channel.send, channel.sendMedia, channel.list, channel.get, channel.register
 * Pure events emitted: channel.onConnected, channel.onDisconnected
 * Pure events subscribed: agent.onTool, agent.onCompleted
 *
 * This file owns adapter lifecycle and the bus surface only. Inbound policy, in-flight
 * run state and reply delivery live in `pipeline.ts`; access rules in `access.ts`.
 *
 * Inbound flow:
 *   adapter → normalizer → pipeline → expand links → access check → agent.execute
 *
 * Reply routing:
 *   - Channel-triggered: the pipeline's completion handler delivers to the source
 *   - Non-channel (cron, etc): no session, so completion is ignored — the caller replies
 *
 * Outbound flow: channel.send → strip markdown → chunk → adapter.send
 */

import { z } from 'zod';
import type { Bus, Service } from '../../core/types.js';
import type { AppConfig, ChannelEntry } from '../../services/config/index.js';
import { createLogger } from '../../lib/logger.js';
import { toMessage } from '../../lib/error.js';
import { stripMarkdown } from '../../lib/util.js';
import { parseChannelTarget } from '../../lib/session-key.js';
import { filterPaginate, ListSchema, type ListParams } from '../../lib/paginate.js';
import type {
  ChannelAdapter,
  ChannelProvider,
  MediaKind,
  NormalizedInboundMessage,
  AdapterDeps,
} from './types.js';
import { shouldExecute } from './access.js';
import { ChannelEntrySchema } from '../config/schemas/channels.js';
import { deliverReply } from './delivery.js';
import { extractMediaPaths } from './media-paths.js';
import { WhatsAppPairing, type PairStatus } from './providers/whatsapp/pairing.js';
import {
  InboundMessagePipeline,
  type AgentToolPayload,
  type AgentCompletedPayload,
} from './pipeline.js';
import { loadProviders } from '../../lib/provider-loader.js';

const log = createLogger('channels');

/** Built-in channel providers, imported lazily so a broken one cannot block boot. */
const PROVIDERS: Record<string, () => Promise<ChannelProvider>> = {
  telegram: () => import('./providers/telegram/index.js').then(m => m.default),
  whatsapp: () => import('./providers/whatsapp/index.js').then(m => m.default),
};

interface ChannelInfo { id: string; type: string; status: string }

export const BOOT_PRIORITY = 70; // telegram / whatsapp listeners — listeners last

export class ChannelService implements Service {
  readonly name = 'channel';
  private adapters = new Map<string, ChannelAdapter>();
  private providers = new Map<string, ChannelProvider>();
  private bus!: Bus;
  private config!: AppConfig;
  private pipeline!: InboundMessagePipeline;
  private waPairing = new WhatsAppPairing((id) => void this.repairAfterPairing(id));

  async init(bus: Bus): Promise<void> {
    this.bus = bus;
    this.config = await bus.call<AppConfig>('config.get', {});
    this.pipeline = new InboundMessagePipeline(bus, this.config);

    this.registerMethods(bus);
    bus.on('agent.onTool', (p: AgentToolPayload) => this.pipeline.onTool(p));
    bus.on('agent.onProgress', async ({ sessionKey, text }: { sessionKey: string; text: string }) => {
      try {
        // Progress is informational: bypass channel.send's final-reply tracking.
        await deliverReply(chunk => this.adapterFor(sessionKey).send(sessionKey, chunk), stripMarkdown(text));
      } catch (error) { log.warn(`progress send failed: ${toMessage(error)}`); }
    });
    bus.on('agent.onCompleted', (p: AgentCompletedPayload) => this.pipeline.onCompleted(p));

    for (const provider of await loadProviders(PROVIDERS)) {
      this.providers.set(provider.type, provider);
    }
    // Skip live adapter startup for one-shot CLI calls — `channel.*` methods are `live`
    // and refused without a daemon, so there is nothing to connect for.
    if (!process.env.VARGOS_CLI_ONESHOT) await this.startAllConfigured();
  }

  async dispose(): Promise<void> {
    this.waPairing.disposeAll();
    for (const adapter of this.adapters.values()) {
      try { await adapter.stop(); } catch { /* best effort */ }
    }
    this.adapters.clear();
  }

  private registerMethods(bus: Bus): void {
    bus.register('channel.send', {
      description: 'Send a text message to a channel recipient. Optional `fromSessionKey` records the text in the target session history.',
      schema: z.object({
        sessionKey: z.string(),
        text: z.string(),
        fromSessionKey: z.string().optional(),
      }),
      cli: { positional: ['sessionKey', 'text'] },
      live: true,
    }, (p) => this.send(p));

    bus.register('channel.sendMedia', {
      description: 'Send a media file to a channel recipient.',
      schema: z.object({
        sessionKey: z.string(),
        filePath: z.string(),
        mimeType: z.string(),
        caption: z.string().optional(),
      }),
      cli: { positional: ['sessionKey', 'filePath', 'mimeType'] },
      live: true,
    }, (p) => this.sendMedia(p));

    bus.register('channel.list', {
      description: 'List connected channel adapters.',
      schema: ListSchema,
      cli: { positional: ['query'] },
      live: true,
    }, (p) => this.list(p));

    bus.register('channel.get', {
      description: 'Get status of a specific channel adapter.',
      schema: z.object({ id: z.string() }),
      cli: { positional: ['id'] },
      live: true,
    }, (p) => this.get(p));

    bus.register('channel.restart', {
      description: 'Restart a channel adapter (stop + start). For WhatsApp: run `channel pair` first, then call this.',
      schema: z.object({ id: z.string() }),
      cli: { positional: ['id'] },
      live: true,
    }, (p) => this.restart(p));

    bus.register('channel.register', {
      description: 'Register a channel adapter and persist it to config. `type` must match a loaded provider (e.g. telegram, whatsapp).',
      schema: z.object({
        id: z.string(),
        type: z.string(),
        enabled: z.boolean().optional(),
        model: z.string().optional(),
        debounceMs: z.number().int().min(0).optional(),
        allowFrom: z.array(z.string()).optional(),
        sentryMode: ChannelEntrySchema.options[0].shape.sentryMode,
        cwd: z.string().optional(),
        botToken: z.string().optional(),
      }),
      cli: { positional: ['type', 'id'] },
      live: true,
    }, (p) => this.registerChannel(p));

    bus.register('channel.pairStart', {
      description: 'Begin WhatsApp QR pairing for a registered channel. Returns { phase, qr? }; poll channel.pairStatus. Pass reset:true to wipe stale auth first.',
      schema: z.object({ id: z.string(), reset: z.boolean().optional() }),
      cli: { positional: ['id'] },
      live: true,
    }, (p) => this.pairStart(p));

    bus.register('channel.pairStatus', {
      description: 'Poll WhatsApp pairing progress: { phase: idle|connecting|qr|connected|saved|expired|error, qr?, name?, error? }.',
      schema: z.object({ id: z.string() }),
      cli: { positional: ['id'] },
      live: true,
    }, (p) => this.waPairing.status(p.id));

    bus.register('channel.pairCancel', {
      description: 'Abort an in-progress WhatsApp pairing session.',
      schema: z.object({ id: z.string() }),
      cli: { positional: ['id'] },
      live: true,
    }, (p) => this.pairCancel(p));

    bus.register('channel.unregister', {
      description: 'Stop a channel adapter and remove its entry from config. Auth state under ~/.vargos/channels/<id> is left in place.',
      schema: z.object({ id: z.string() }),
      cli: { positional: ['id'] },
      live: true,
    }, (p) => this.unregisterChannel(p));
  }

  // ── WhatsApp pairing ─────────────────────────────────────────────────────────

  private async pairStart(p: { id: string; reset?: boolean }): Promise<PairStatus> {
    if (!this.providers.has('whatsapp')) throw new Error('whatsapp provider is not loaded');
    const cfg = await this.bus.call<AppConfig>('config.get', {});
    const entry = cfg.channels.find(c => c.id === p.id);
    if (!entry) throw new Error(`No channel registered with id "${p.id}" — register it first.`);
    if (entry.type !== 'whatsapp') throw new Error(`Channel "${p.id}" is ${entry.type}, not whatsapp.`);

    // The unpaired adapter is inert (repair state, no socket), but stop it anyway
    // so the auth dir is unambiguously free for the pairing socket.
    await this.adapters.get(p.id)?.stop().catch(() => {});
    return this.waPairing.start(p.id, { reset: p.reset });
  }

  private async pairCancel(p: { id: string }): Promise<{ cancelled: boolean }> {
    await this.waPairing.cancel(p.id);
    await this.adapters.get(p.id)?.start().catch(() => {});
    return { cancelled: true };
  }

  private async unregisterChannel(p: { id: string }): Promise<{ removed: boolean; id: string }> {
    await this.waPairing.cancel(p.id);
    const adapter = this.adapters.get(p.id);
    if (adapter) {
      try { await adapter.stop(); } catch { /* best effort */ }
      this.adapters.delete(p.id);
    }

    const cfg = await this.bus.call<AppConfig>('config.get', {});
    const next = cfg.channels.filter(c => c.id !== p.id);
    const removed = next.length !== cfg.channels.length;
    if (removed) await this.bus.call('config.set', { ...cfg, channels: next });

    this.bus.emit('channel.onDisconnected', { instanceId: p.id });
    log.info(`unregistered channel: ${p.id}`);
    return { removed, id: p.id };
  }

  /** Fired by WhatsAppPairing once creds are on disk — bring the real adapter online. */
  private async repairAfterPairing(id: string): Promise<void> {
    try {
      if (this.adapters.has(id)) {
        await this.restart({ id });
      } else {
        const cfg = await this.bus.call<AppConfig>('config.get', {});
        const entry = cfg.channels.find(c => c.id === id);
        if (entry) await this.startChannel(entry);
      }
      log.info(`${id}: adapter online after pairing`);
    } catch (err) {
      log.error(`${id}: adapter failed to come up after pairing: ${toMessage(err)}`);
    }
  }

  // ── Callable handlers ────────────────────────────────────────────────────────

  private async send(params: { sessionKey: string; text: string; fromSessionKey?: string }): Promise<{ sent: boolean }> {
    const { sessionKey, text, fromSessionKey } = params;
    const adapter = this.adapterFor(sessionKey);

    log.debug(`send: ${sessionKey} (${text.length} chars)`);
    await deliverReply((chunk) => adapter.send(sessionKey, chunk), stripMarkdown(text));

    // Tell the pipeline the agent replied itself, so completion doesn't send it again
    this.pipeline.markReplied(sessionKey);

    if (adapter.sendMedia) {
      for (const { filePath, mimeType } of extractMediaPaths(text)) {
        await adapter.sendMedia(sessionKey, filePath, mimeType)
          .catch(err => log.error(`media send failed: ${filePath}: ${err}`));
      }
    }

    if (fromSessionKey) {
      this.bus.call('agent.appendMessage', {
        sessionKey,
        content: `[${fromSessionKey}] ${text}`,
      }).catch(err => log.error(`history append to ${sessionKey} from ${fromSessionKey}: ${toMessage(err)}`));
    }

    return { sent: true };
  }

  private async sendMedia(params: { sessionKey: string; filePath: string; mimeType: string; caption?: string }): Promise<{ sent: boolean }> {
    const { sessionKey, filePath, mimeType, caption } = params;
    const adapter = this.adapterFor(sessionKey);
    if (!adapter.sendMedia) throw new Error(`Channel ${adapter.instanceId} does not support media`);

    await adapter.sendMedia(sessionKey, filePath, mimeType, caption);
    return { sent: true };
  }

  private list(params: ListParams) {
    const all: ChannelInfo[] = Array.from(this.adapters.values()).map(a => ({
      id: a.instanceId,
      type: a.type,
      status: a.status,
    }));
    return filterPaginate(all, params, c => [c.id, c.type]);
  }

  private async get(params: { id: string }): Promise<ChannelInfo> {
    const adapter = this.adapters.get(params.id);
    if (!adapter) throw new Error(`No adapter for channel: ${params.id}`);
    return { id: adapter.instanceId, type: adapter.type, status: adapter.status };
  }

  private async restart(params: { id: string }): Promise<{ restarted: boolean; id: string }> {
    const adapter = this.adapters.get(params.id);
    if (!adapter) throw new Error(`No adapter for channel: ${params.id}`);
    log.info(`restarting channel: ${params.id}`);
    await adapter.stop();
    await adapter.start();
    log.info(`channel restarted: ${params.id} (status=${adapter.status})`);
    return { restarted: true, id: params.id };
  }

  private async registerChannel(
    entry: ChannelEntry,
  ): Promise<{ id: string; type: string; started: boolean; persisted: boolean }> {
    if (!this.providers.has(entry.type)) {
      throw new Error(`Unknown channel type: ${entry.type}. Loaded providers: ${[...this.providers.keys()].join(', ')}`);
    }

    if (this.adapters.has(entry.id)) {
      log.info(`channel already registered: ${entry.id}`);
      return { id: entry.id, type: entry.type, started: false, persisted: false };
    }
    await this.startChannel(entry);

    // Persist by default so a CLI/RPC registration survives the process; the daemon
    // picks it up on next load. Pass persist:false for an ephemeral runtime-only adapter.
    let persisted = false;

    const config = await this.bus.call<AppConfig>('config.get', {});
    if (!config.channels.some(c => c.id === entry.id)) {
      await this.bus.call('config.set', { ...config, channels: [...config.channels, entry] });
      persisted = true;
    }

    return { id: entry.id, type: entry.type, started: true, persisted };
  }

  // ── Inbound handoff ──────────────────────────────────────────────────────────

  /** Called by adapters once a message is normalized, debounced and enriched. */
  private async onInboundMessage(sessionKey: string, message: NormalizedInboundMessage): Promise<void> {
    const target = parseChannelTarget(sessionKey);
    if (!target) {
      log.debug(`invalid session key: ${sessionKey}`);
      return;
    }

    const adapter = this.adapters.get(target.channel);
    if (!adapter) {
      log.debug(`no adapter for channel: ${target.channel}`);
      return;
    }

    await this.pipeline.process(sessionKey, message, adapter);
  }

  // ── Channel startup ──────────────────────────────────────────────────────────

  private adapterFor(sessionKey: string): ChannelAdapter {
    const target = parseChannelTarget(sessionKey);
    if (!target) throw new Error(`Invalid session key: ${sessionKey}`);

    const adapter = this.adapters.get(target.channel);
    if (!adapter) throw new Error(`No adapter for channel: ${target.channel}`);
    return adapter;
  }

  private async startChannel(entry: ChannelEntry): Promise<void> {
    const provider = this.providers.get(entry.type);
    if (!provider) {
      log.warn(`unknown channel type: ${entry.type} (id=${entry.id})`);
      return;
    }

    const adapter = await provider.createAdapter(entry.id, entry, this.adapterDeps(entry));
    this.adapters.set(entry.id, adapter);

    try {
      await adapter.start();
      log.info(`channel started: ${entry.id} (${entry.type})`);
      this.bus.emit('channel.onConnected', { instanceId: entry.id, type: entry.type });
    } catch (err) {
      log.error(`channel start failed: ${entry.id}: ${toMessage(err)}`);
      this.bus.emit('channel.onDisconnected', { instanceId: entry.id });
    }
  }

  /**
   * The only core capabilities an adapter gets. `shouldEnrich` mirrors the pipeline's
   * execution rule so we never pay for a transcript of a message we will not act on.
   */
  private adapterDeps(entry: ChannelEntry): AdapterDeps {
    return {
      onInbound: (sessionKey, message) => this.onInboundMessage(sessionKey, message),
      enrichMedia: (kind, filePath, mimeType) => this.enrichMedia(kind, filePath, mimeType),
      shouldReceive: (m) => entry.sentryMode === true || shouldExecute(entry.allowFrom, m.fromUserId, m.chatType, m.isMentioned),
      shouldEnrich: (m) => shouldExecute(entry.allowFrom, m.fromUserId, m.chatType, m.isMentioned),
    };
  }

  private enrichMedia(kind: MediaKind, filePath: string, mimeType: string): Promise<string> {
    if (kind === 'image') {
      return this.bus.call<{ description: string }>('media.describeImage', { filePath }).then(r => r.description);
    }
    if (kind === 'audio') {
      return this.bus.call<{ text: string }>('media.transcribeAudio', { filePath }).then(r => r.text);
    }
    return this.bus.call<{ text: string }>('media.extractDocument', { filePath, mimeType }).then(r => r.text);
  }

  private async startAllConfigured(): Promise<void> {
    log.info(`starting all configured ${this.config.channels.length} channels...`);
    for (const entry of this.config.channels) {
      if (entry.enabled === false) {
        log.info(`channel skipped (disabled): ${entry.id}`);
        continue;
      }
      try {
        await this.startChannel(entry);
      } catch (err) {
        log.error(`failed to start channel ${entry.id}: ${toMessage(err)}`);
      }
    }
    if (this.adapters.size > 0) {
      log.info(`started ${this.adapters.size} channel(s)`);
    }
  }
}

export function createService(): Service {
  return new ChannelService();
}
