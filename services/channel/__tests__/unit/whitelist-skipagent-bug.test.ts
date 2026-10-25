/**
 * Whitelisted user sends "@VargosBot are u up?" with an @mention in a group: the
 * normalizer must detect the @username mention (not only reply_to_message) so the
 * pipeline routes to agent.execute, not agent.appendMessage.
 *
 * End-to-end over the real seam: raw Telegram message → base adapter → service →
 * pipeline → bus. Only the transport and the bus are faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EmitterBus } from '../../../../core/bus.js';
import { ChannelService } from '../../index.js';
import { BaseChannelAdapter } from '../../base-adapter.js';
import { normalizeTelegramMessage } from '../../providers/telegram/normalizer.js';
import type { AppConfig } from '../../../config/index.js';
import type { AdapterDeps, NormalizedInboundMessage } from '../../types.js';
import type { TelegramMessage } from '../../providers/telegram/types.js';

class MockTelegramAdapter extends BaseChannelAdapter<TelegramMessage> {
  readonly type = 'telegram' as const;
  botUserId = 987654321;
  botUsername = 'VargosBot';

  constructor(instanceId: string, deps: AdapterDeps) {
    super(instanceId, deps, 5);
  }

  async start(): Promise<void> { this.status = 'connected'; }
  async stop(): Promise<void> { this.cleanup(); this.status = 'disconnected'; }

  protected normalize(msg: TelegramMessage): NormalizedInboundMessage | null {
    return normalizeTelegramMessage(msg, { botUserId: this.botUserId, botUsername: this.botUsername });
  }

  protected async sendText(): Promise<void> {}
  protected async sendTyping(): Promise<void> {}

  /** Feed a raw Telegram message through the real inbound path. */
  inbound(msg: TelegramMessage): Promise<void> { return this.receive(msg); }
}

describe('Whitelist + mention routing', () => {
  let bus: EmitterBus;
  let channelService: ChannelService;
  let adapter: MockTelegramAdapter;
  let agentExecuteCalls: Array<{ sessionKey?: string; task: string }>;
  let agentAppendMessageCalls: Array<{ sessionKey: string; content: string }>;

  const WHITELISTED_USER_ID = '100001';
  const OUTSIDER_USER_ID = '999999';
  const GROUP_CHAT_ID = '-100123456789';

  const mockConfig = {
    providers: { test: { baseUrl: 'http://localhost', apiKey: 'test', api: 'test', models: [] } },
    agent: { model: 'test:test' },
    // enabled: false → init() skips starting a real Telegram adapter; the mock is injected below.
    channels: [{ id: 'telegram-vargos', type: 'telegram' as const, botToken: 'test-token', enabled: false, sentryMode: true, allowFrom: [WHITELISTED_USER_ID] }],
    webhooks: [], linkExpand: {}, mcp: {}, paths: {}, gateway: { port: 9000 },
  } as unknown as AppConfig;

  function groupMessage(fromUserId: string, text: string, messageId: number): TelegramMessage {
    return {
      message_id: messageId,
      from: { id: parseInt(fromUserId), is_bot: false, first_name: 'TestUser' },
      chat: { id: parseInt(GROUP_CHAT_ID), type: 'group' },
      date: Math.floor(Date.now() / 1000),
      text,
    };
  }

  const settle = () => new Promise(r => setTimeout(r, 30));

  beforeEach(async () => {
    agentExecuteCalls = [];
    agentAppendMessageCalls = [];
    bus = new EmitterBus();

    vi.spyOn(bus, 'call').mockImplementation(async (event: string, params?: unknown) => {
      if (event === 'config.get') return mockConfig as unknown;
      if (event === 'agent.execute') { agentExecuteCalls.push(params as { sessionKey?: string; task: string }); return { response: 'executed' }; }
      if (event === 'agent.appendMessage') { agentAppendMessageCalls.push(params as { sessionKey: string; content: string }); return { appended: true }; }
      return {};
    });

    channelService = new ChannelService();
    await channelService.init(bus);

    adapter = new MockTelegramAdapter('telegram-vargos', {
      onInbound: channelService['onInboundMessage'].bind(channelService),
      enrichMedia: async () => '',
      shouldEnrich: () => true,
    });
    await adapter.start();
    (channelService as unknown as { adapters: Map<string, unknown> }).adapters.set('telegram-vargos', adapter);
  });

  afterEach(async () => { await adapter.stop(); });

  it('whitelisted user in group with @mention executes agent, not append', async () => {
    await adapter.inbound(groupMessage(WHITELISTED_USER_ID, '@VargosBot are u up?', 100));
    await settle();

    expect(agentExecuteCalls).toHaveLength(1);
    expect(agentAppendMessageCalls).toHaveLength(0);
    expect(agentExecuteCalls[0].task).toBe('@VargosBot are u up?');
    expect(agentExecuteCalls[0].sessionKey).toBe(`telegram-vargos:${GROUP_CHAT_ID}`);
  });

  it('whitelisted user without a mention is observed, not executed', async () => {
    await adapter.inbound(groupMessage(WHITELISTED_USER_ID, 'just chatting', 101));
    await settle();

    expect(agentExecuteCalls).toHaveLength(0);
    expect(agentAppendMessageCalls).toHaveLength(1);
  });

  it('outsider with a mention is observed, not executed', async () => {
    await adapter.inbound(groupMessage(OUTSIDER_USER_ID, '@VargosBot hello', 102));
    await settle();

    expect(agentExecuteCalls).toHaveLength(0);
    expect(agentAppendMessageCalls).toHaveLength(1);
  });
});
