/**
 * BaseChannelAdapter owns the one inbound path every provider shares: normalize,
 * dedupe, debounce, resolve media, emit. These tests describe that path — providers
 * only supply the transport hooks, so anything asserted here holds for all channels.
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  AdapterDeps,
  ChannelAdapter,
  InboundMediaSource,
  MediaKind,
  NormalizedInboundMessage,
} from '../../types.js';
import { BaseChannelAdapter } from '../../base-adapter.js';

vi.mock('../../../../lib/media.js', () => ({
  saveMedia: vi.fn(async () => '/data/media/saved.bin'),
}));

interface RawMsg {
  id: string;
  chatId: string;
  text?: string;
  media?: MediaKind;
  ignore?: boolean;
}

class TestAdapter extends BaseChannelAdapter<RawMsg> {
  readonly type = 'test' as const;
  readonly emitted: Array<{ sessionKey: string; message: NormalizedInboundMessage }> = [];
  readonly sent: Array<{ chatId: string; text: string }> = [];
  readonly typed: string[] = [];
  mediaSource: InboundMediaSource | null = { buffer: Buffer.from('bytes'), mimeType: 'image/png' };

  constructor(deps: Partial<AdapterDeps> = {}, debounceMs = 5) {
    super('test-inst', {
      onInbound: async (sessionKey, message) => { this.emitted.push({ sessionKey, message }); },
      enrichMedia: async () => 'enriched',
      shouldEnrich: () => true,
      ...deps,
    }, debounceMs);
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> { this.cleanup(); }

  protected normalize(raw: RawMsg): NormalizedInboundMessage | null {
    if (raw.ignore) return null;
    return {
      messageId: raw.id,
      chatId: raw.chatId,
      fromUserId: 'sender-1',
      chatType: 'group',
      isMentioned: true,
      text: raw.text,
      mediaKind: raw.media,
    };
  }

  protected async sendText(chatId: string, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }

  protected async sendTyping(chatId: string): Promise<void> {
    this.typed.push(chatId);
  }

  protected async resolveMedia(): Promise<InboundMediaSource | null> {
    return this.mediaSource;
  }

  /** `receive` is the provider-facing entry point; expose it for the tests. */
  inbound(raw: RawMsg): Promise<void> { return this.receive(raw); }
}

const settle = (ms = 30) => new Promise(r => setTimeout(r, ms));

describe('BaseChannelAdapter inbound path', () => {
  it('drops ignored text and attachments before downloading or saving', async () => {
    const { saveMedia } = await import('../../../../lib/media.js');
    vi.mocked(saveMedia).mockClear();
    const adapter = new TestAdapter({ shouldReceive: () => false });
    const resolve = vi.spyOn(adapter as unknown as { resolveMedia: () => Promise<InboundMediaSource | null> }, 'resolveMedia');
    await adapter.inbound({ id: 'ignored-text', chatId: 'group-9', text: 'ignored' });
    await adapter.inbound({ id: 'ignored-media', chatId: 'group-9', media: 'image' });
    await adapter.stop();
    expect(adapter.emitted).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
    expect(saveMedia).not.toHaveBeenCalled();
  });

  it('emits a session key built from the chat, not the sender', async () => {
    const adapter = new TestAdapter();
    await adapter.inbound({ id: 'm1', chatId: 'group-9', text: 'hi' });
    await settle();

    expect(adapter.emitted).toHaveLength(1);
    expect(adapter.emitted[0].sessionKey).toBe('test-inst:group-9');
    expect(adapter.emitted[0].message.fromUserId).toBe('sender-1');
  });

  it('drops a message the provider chose to ignore', async () => {
    const adapter = new TestAdapter();
    await adapter.inbound({ id: 'm1', chatId: 'c1', text: 'hi', ignore: true });
    await settle();

    expect(adapter.emitted).toHaveLength(0);
  });

  it('drops a repeated message id within the same chat', async () => {
    const adapter = new TestAdapter();
    await adapter.inbound({ id: 'm1', chatId: 'c1', text: 'once' });
    await adapter.inbound({ id: 'm1', chatId: 'c1', text: 'again' });
    await settle();

    expect(adapter.emitted).toHaveLength(1);
  });

  it('keeps the same message id in different chats — ids are only chat-unique', async () => {
    const adapter = new TestAdapter();
    await adapter.inbound({ id: 'm1', chatId: 'c1', text: 'here' });
    await adapter.inbound({ id: 'm1', chatId: 'c2', text: 'there' });
    await settle();

    expect(adapter.emitted.map(e => e.sessionKey)).toEqual(['test-inst:c1', 'test-inst:c2']);
  });

  it('batches rapid messages into one turn, carrying the latest metadata', async () => {
    const adapter = new TestAdapter();
    await adapter.inbound({ id: 'm1', chatId: 'c1', text: 'first' });
    await adapter.inbound({ id: 'm2', chatId: 'c1', text: 'second' });
    await settle();

    expect(adapter.emitted).toHaveLength(1);
    expect(adapter.emitted[0].message.text).toBe('first\nsecond');
    expect(adapter.emitted[0].message.messageId).toBe('m2');
  });

  it('tracks the latest message id per chat, for reaction anchoring', async () => {
    const adapter = new TestAdapter();
    await adapter.inbound({ id: 'm1', chatId: 'c1', text: 'a' });
    await adapter.inbound({ id: 'm2', chatId: 'c1', text: 'b' });
    await adapter.inbound({ id: 'm3', chatId: 'c2', text: 'c' });

    expect(adapter.latestMessageId('c1')).toBe('m2');
    expect(adapter.latestMessageId('c2')).toBe('m3');
    expect(adapter.latestMessageId('unknown')).toBeUndefined();
  });

  it('anchors reactions to media messages too', async () => {
    const adapter = new TestAdapter();
    await adapter.inbound({ id: 'm1', chatId: 'c1', media: 'image' });

    expect(adapter.latestMessageId('c1')).toBe('m1');
  });
});

describe('BaseChannelAdapter media handling', () => {
  it('enriches media into text and appends the saved path', async () => {
    const adapter = new TestAdapter({
      enrichMedia: async () => 'a photo of a cat',
    });
    await adapter.inbound({ id: 'm1', chatId: 'c1', media: 'image' });

    expect(adapter.emitted[0].message.text)
      .toBe('a photo of a cat\n\n[Image: /data/media/saved.bin]');
  });

  it('skips enrichment when the message will not run the agent', async () => {
    const enrichMedia = vi.fn(async () => 'expensive transcript');
    const adapter = new TestAdapter({ enrichMedia, shouldEnrich: () => false });
    adapter.mediaSource = { buffer: Buffer.from('x'), mimeType: 'audio/ogg', duration: 12 };

    await adapter.inbound({ id: 'm1', chatId: 'c1', media: 'audio' });

    expect(enrichMedia).not.toHaveBeenCalled();
    expect(adapter.emitted[0].message.text).toBe('[Audio, 12s]\n\n[Audio: /data/media/saved.bin]');
  });

  it('falls back to the saved path when enrichment throws', async () => {
    const adapter = new TestAdapter({
      enrichMedia: async () => { throw new Error('media service down'); },
    });
    adapter.mediaSource = { buffer: Buffer.from('x'), mimeType: 'image/png', caption: 'my holiday' };

    await adapter.inbound({ id: 'm1', chatId: 'c1', media: 'image' });

    expect(adapter.emitted[0].message.text).toBe('my holiday\n\n[Image: /data/media/saved.bin]');
  });

  it('emits a placeholder rather than nothing when the bytes cannot be fetched', async () => {
    const adapter = new TestAdapter();
    adapter.mediaSource = null;

    await adapter.inbound({ id: 'm1', chatId: 'c1', media: 'document', text: 'see attached' });

    expect(adapter.emitted[0].message.text).toBe('[Document] see attached');
  });

  it('flushes buffered text before the media turn, so order is preserved', async () => {
    const adapter = new TestAdapter();
    await adapter.inbound({ id: 'm1', chatId: 'c1', text: 'look at this' });
    await adapter.inbound({ id: 'm2', chatId: 'c1', media: 'image' });
    await settle();

    expect(adapter.emitted.map(e => e.message.messageId)).toEqual(['m1', 'm2']);
  });

  it('never rejects — a provider may call it fire-and-forget', async () => {
    const adapter = new TestAdapter();
    adapter.mediaSource = null;
    vi.spyOn(adapter as unknown as { resolveMedia: () => Promise<never> }, 'resolveMedia')
      .mockRejectedValue(new Error('download exploded'));

    await expect(adapter.inbound({ id: 'm1', chatId: 'c1', media: 'image' })).resolves.toBeUndefined();
    expect(adapter.emitted).toHaveLength(0);
  });
});

describe('BaseChannelAdapter outbound', () => {
  it('routes a send to the chat named by the session key', async () => {
    const adapter = new TestAdapter();
    await adapter.send('test-inst:group-9', 'hello');

    expect(adapter.sent).toEqual([{ chatId: 'group-9', text: 'hello' }]);
  });

  it('starts and stops the typing indicator', async () => {
    const adapter = new TestAdapter();
    adapter.startTyping('test-inst:c1');
    await settle(5);
    adapter.stopTyping('test-inst:c1');

    expect(adapter.typed).toEqual(['c1']);
  });

  it('leaves react undefined for channels that do not support it', () => {
    const adapter: ChannelAdapter = new TestAdapter();
    expect(adapter.react).toBeUndefined();
  });
});
