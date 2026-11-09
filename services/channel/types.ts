/**
 * Channel types and adapter contracts — the boundary between core policy and
 * provider implementations.
 *
 * Two contracts live here:
 *   - `ChannelAdapter`: what the service and pipeline may call. Speaks session keys.
 *   - `AdapterDeps`: what an adapter may call back into core. Speaks normalized messages.
 *
 * The provider-facing contract (normalize, resolveMedia, sendText, …) is the abstract
 * member block of `BaseChannelAdapter`. Providers never see session keys or access policy.
 */

import type { ChannelEntry } from '../config/schemas/channels.js';

export type ChannelStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type ChannelType = 'whatsapp' | 'telegram' | (string & {});
export type MediaKind = 'image' | 'audio' | 'video' | 'document';

export interface InboundMediaSource {
  buffer: Buffer;
  mimeType: string;
  caption?: string;
  duration?: number;
}

export interface ExtractedMedia {
  filePath: string;
  mimeType: string;
}

/** What core (service + pipeline) may call on any adapter. */
export interface ChannelAdapter {
  readonly instanceId: string;
  readonly type: ChannelType;
  readonly status: ChannelStatus;

  start(): Promise<void>;
  stop(): Promise<void>;

  send(sessionKey: string, text: string): Promise<void>;
  /** Idempotent while active; also resumes an indicator paused by its TTL. */
  startTyping(sessionKey: string): void;
  stopTyping(sessionKey: string): void;
  /** Id of the most recent message in a chat — the anchor for status reactions. */
  latestMessageId(chatId: string): string | undefined;

  // Optional capabilities — feature-detected before use.
  sendMedia?: (sessionKey: string, filePath: string, mimeType: string, caption?: string) => Promise<void>;
  react?: (sessionKey: string, messageId: string, emoji: string) => Promise<void>;
}

/**
 * Adapter dependencies — core services an adapter may reach, injected at construction.
 * Keeping media enrichment and the enrichment decision here is what lets adapters stay
 * ignorant of both the bus and the whitelist.
 */
export interface AdapterDeps {
  onInbound: OnInboundMessageFn;
  /** Drop ignored messages before debounce, media downloads, and persistence. */
  shouldReceive?: (message: NormalizedInboundMessage) => boolean;
  /** Turn a saved media file into text: a transcript, a description, an extraction. */
  enrichMedia: (kind: MediaKind, filePath: string, mimeType: string) => Promise<string>;
  /** Whether enrichment is worth its cost — true when this message will run the agent. */
  shouldEnrich: (message: NormalizedInboundMessage) => boolean;
}

/**
 * Provider pattern: factory for creating channel adapters.
 * Generic over the channel entry type for type-safe config passing.
 */
export interface ChannelProvider<TEntry extends ChannelEntry = ChannelEntry> {
  readonly type: TEntry['type'];
  createAdapter(instanceId: string, config: TEntry, deps: AdapterDeps): Promise<ChannelAdapter>;
}

/**
 * Canonical inbound message shape after normalization.
 * All providers emit this; all core policy reads it.
 *
 * `chatId` and `fromUserId` differ in groups and must not be conflated: replies and
 * reactions go to `chatId`, whitelist checks are about `fromUserId`.
 */
export interface NormalizedInboundMessage {
  messageId: string;
  chatId: string;                  // Reply destination — becomes the session key
  fromUserId: string;              // Sender: JID or numeric id, used for whitelist
  chatType: 'private' | 'group';
  isMentioned: boolean;
  text?: string;
  mediaKind?: MediaKind;           // Set when the raw message carries media
}

/**
 * Callback signature for inbound messages.
 * The base adapter calls this once per message, after debouncing and media enrichment.
 */
export type OnInboundMessageFn = (
  sessionKey: string,
  normalizedMessage: NormalizedInboundMessage,
) => Promise<void>;
