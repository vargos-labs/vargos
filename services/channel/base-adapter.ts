/**
 * Base channel adapter — owns everything a channel does that is not transport:
 * dedupe, debounce, session keys, typing lifecycle, media persistence and enrichment.
 *
 * There is exactly one inbound path (`receive`), so provider drift is not expressible.
 * Providers implement the transport hooks in the contract block at the bottom.
 */

import path from 'node:path';
import type {
  ChannelType,
  InboundMediaSource,
  ChannelAdapter,
  NormalizedInboundMessage,
  AdapterDeps,
  ChannelStatus,
  MediaKind,
} from './types.js';
import { createDedupeCache } from './dedupe.js';
import { createMessageDebouncer, type MessageDebouncer } from './debounce.js';
import { createLogger } from '../../lib/logger.js';
import { toMessage } from '../../lib/error.js';
import { parseSessionKey } from '../../lib/session-key.js';
import { TypingStateManager } from './typing-state.js';
import { saveMedia } from '../../lib/media.js';
import { getDataPaths } from '../../lib/paths.js';

const LABELS: Record<MediaKind, string> = {
  image: 'Image',
  audio: 'Audio',
  video: 'Video message',
  document: 'Document',
};

/** Kinds the media service can turn into text. Video is saved but never enriched. */
const ENRICHABLE = new Set<MediaKind>(['image', 'audio', 'document']);

export abstract class BaseChannelAdapter<TRaw = never> implements ChannelAdapter {
  abstract readonly type: ChannelType;
  readonly instanceId: string;
  status: ChannelStatus = 'disconnected';

  protected readonly log;
  private readonly deps: AdapterDeps;
  private readonly debouncer: MessageDebouncer;
  private readonly dedupe = createDedupeCache({ ttlMs: 120_000 });
  private readonly typing = new TypingStateManager({ ttlMs: 120_000, failureLimit: 3 });
  private readonly lastMessageIds = new Map<string, string>();

  constructor(instanceId: string, deps: AdapterDeps, debounceMs = 2000) {
    this.instanceId = instanceId;
    this.deps = deps;
    this.log = createLogger(instanceId);
    this.debouncer = createMessageDebouncer(
      (_chatId, texts, msg) => {
        if (msg) void this.emit(msg, texts.join('\n'));
      },
      { delayMs: debounceMs },
    );
  }

  // ── Inbound: the single path every provider uses ─────────────────────────────

  /**
   * Entry point for raw provider events. Normalizes, drops duplicates, batches rapid
   * text, resolves media. Never rejects — providers may call it fire-and-forget.
   */
  protected async receive(raw: TRaw): Promise<void> {
    try {
      const msg = this.normalize(raw);
      if (!msg) return;
      if (this.deps.shouldReceive && !this.deps.shouldReceive(msg)) return;

      // Chat-scoped: message ids are only unique within a chat on some platforms.
      if (!this.dedupe.add(`${msg.chatId}:${msg.messageId}`)) return;
      this.lastMessageIds.set(msg.chatId, msg.messageId);

      if (!msg.mediaKind) {
        this.debouncer.push(msg.chatId, msg.text ?? '', msg);
        return;
      }

      // Media supersedes anything still buffered — flush it as its own turn first.
      this.debouncer.flush(msg.chatId);
      await this.emit(msg, await this.mediaText(raw, msg));
    } catch (err) {
      this.log.error(`inbound failed: ${toMessage(err)}`);
    }
  }

  /** Save the media, describe it when that is worth doing, and append the saved path. */
  private async mediaText(raw: TRaw, msg: NormalizedInboundMessage): Promise<string> {
    const kind = msg.mediaKind!;
    const label = LABELS[kind];

    const source = await this.resolveMedia(raw);
    if (!source) return msg.text ? `[${label}] ${msg.text}` : `[${label} received]`;

    const savedPath = await saveMedia({
      buffer: source.buffer,
      sessionKey: this.sessionKey(msg.chatId),
      mimeType: source.mimeType,
      mediaDir: path.join(getDataPaths().dataDir, 'media'),
    });

    return `${await this.caption(source, savedPath, kind, msg)}\n\n[${label}: ${savedPath}]`;
  }

  private async caption(
    source: InboundMediaSource,
    savedPath: string,
    kind: MediaKind,
    msg: NormalizedInboundMessage,
  ): Promise<string> {
    const { enrichMedia, shouldEnrich } = this.deps;

    if (ENRICHABLE.has(kind) && shouldEnrich(msg)) {
      try {
        return await enrichMedia(kind, savedPath, source.mimeType);
      } catch (err) {
        this.log.warn(`${LABELS[kind]} enrichment failed: ${toMessage(err)} — falling back to path`);
      }
    }
    else {
      this.log.debug(`${LABELS[kind]} enrichment skipped`);
    }

    const duration = source.duration != null ? `, ${source.duration}s` : '';
    return source.caption || `[${LABELS[kind]}${duration}]`;
  }

  private async emit(msg: NormalizedInboundMessage, text: string): Promise<void> {
    this.log.debug(`inbound ${msg.chatId}: "${text.slice(0, 80)}"`);
    await this.deps.onInbound(this.sessionKey(msg.chatId), { ...msg, text });
  }

  // ── Outbound and state, called by core ───────────────────────────────────────

  send(sessionKey: string, text: string): Promise<void> {
    return this.sendText(this.chatId(sessionKey), text);
  }

  startTyping(sessionKey: string): void {
    this.typing.start(sessionKey, () => this.sendTyping(this.chatId(sessionKey)));
  }

  stopTyping(sessionKey: string): void {
    this.typing.stop(sessionKey);
  }

  latestMessageId(chatId: string): string | undefined {
    return this.lastMessageIds.get(chatId);
  }

  /** Release timers. Providers must call this from `stop()`. */
  protected cleanup(): void {
    this.debouncer.flushAll();
    this.typing.cleanup();
  }

  /** The chat this session key addresses — the inverse of `sessionKey()`. */
  protected chatId(sessionKey: string): string {
    return parseSessionKey(sessionKey).id;
  }

  private sessionKey(chatId: string): string {
    return `${this.instanceId}:${chatId}`;
  }

  // ── Provider contract ────────────────────────────────────────────────────────

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  /** Convert a raw platform event into the canonical shape, or null to ignore it. */
  protected abstract normalize(raw: TRaw): NormalizedInboundMessage | null;

  protected abstract sendText(chatId: string, text: string): Promise<void>;
  protected abstract sendTyping(chatId: string): Promise<void>;

  /** Fetch bytes for a message whose `mediaKind` is set. Null falls back to a placeholder. */
  protected async resolveMedia(_raw: TRaw): Promise<InboundMediaSource | null> {
    return null;
  }
}
