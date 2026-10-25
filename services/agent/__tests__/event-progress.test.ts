import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { AgentService } from '../index.js';
import { AppConfigSchema, type AppConfig } from '../../config/index.js';
import { ChannelService } from '../../channel/index.js';
import type { ChannelAdapter } from '../../channel/types.js';
import { EmitterBus } from '../../../core/bus.js';

class Runtime extends AgentService {
  watch(bus: EmitterBus, config: AppConfig, key: string, session: AgentSession) {
    this.bus = bus;
    this.config = config;
    this.subscribeToSessionEvents(session, key);
  }
}

describe('event-driven session progress', () => {
  let bus: EmitterBus;
  let channel: ChannelService;
  let adapter: ChannelAdapter;
  let event: (value: Record<string, unknown>) => void;
  let progress: ReturnType<typeof vi.fn>;
  const key = 'test:user';

  async function setup(sessionKey = key) {
    bus = new EmitterBus();
    const config = AppConfigSchema.parse({ channels: [{ id: 'test', type: 'whatsapp', enabled: false }] });
    bus.register('config.get', { schema: z.object({}) }, () => config);
    bus.register('agent.execute', { schema: z.object({}).passthrough() }, () => ({ response: 'Done' }));
    channel = new ChannelService();
    await channel.init(bus);
    adapter = {
      instanceId: 'test', type: 'whatsapp', status: 'connected', stop: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined), startTyping: vi.fn(), stopTyping: vi.fn(),
      latestMessageId: () => undefined,
    } as unknown as ChannelAdapter;
    channel['adapters'].set('test', adapter);
    progress = vi.fn();
    bus.on('agent.onProgress', progress);
    const session = {
      subscribe: (listener: (e: AgentSessionEvent) => void) => { event = e => listener(e as AgentSessionEvent); },
      state: { messages: [{ role: 'assistant', content: 'Final answer' }] },
    } as unknown as AgentSession;
    new Runtime().watch(bus, config, sessionKey, session);
    event({ type: 'agent_start' });
  }
  const commentary = (text: string) => event({ type: 'message_end', message: {
    role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text }],
  } });
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => { await channel?.dispose(); vi.clearAllTimers(); vi.useRealTimers(); });

  it('checks elapsed time on events, with no timer, and throttles repeated events', async () => {
    await setup();
    commentary('I’m checking the deployment logs.');
    await vi.advanceTimersByTimeAsync(89_999);
    event({ type: 'tool_execution_update' });
    expect(progress).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(progress).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    event({ type: 'tool_execution_update', partialResult: 'private output' });
    event({ type: 'tool_execution_start', toolName: 'bash', args: { secret: 'private args' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(adapter.send).toHaveBeenCalledExactlyOnceWith(key, 'I’m checking the deployment logs.');
    expect(JSON.stringify(progress.mock.calls)).not.toMatch(/private output|private args/);
  });

  it('uses complete public commentary but excludes final text and private thinking', async () => {
    await setup();
    await vi.advanceTimersByTimeAsync(90_000);
    event({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [
      { type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'I found the likely cause; I’m testing the fix.' },
    ] } });
    expect(progress).toHaveBeenCalledExactlyOnceWith({ sessionKey: key, text: 'I found the likely cause; I’m testing the fix.' });
    await vi.advanceTimersByTimeAsync(90_000);
    event({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Final answer' }] } });
    expect(progress).toHaveBeenCalledTimes(1);
  });

  it('maps SDK text deltas correctly without forwarding thinking deltas', async () => {
    await setup();
    const delta = vi.fn();
    bus.on('agent.onDelta', delta);
    await vi.advanceTimersByTimeAsync(90_000);
    event({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'private reasoning' } });
    expect(delta).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'public text' } });
    expect(delta).toHaveBeenCalledExactlyOnceWith({ sessionKey: key, chunk: 'public text' });
  });

  it.each(['cron:job:today', 'webhook:hook:1', 'cli:adhoc', 'test:user:subagent:child'])('ignores non-channel sessions: %s', async otherKey => {
    await setup(otherKey);
    commentary('Checking the deployment.');
    await vi.advanceTimersByTimeAsync(90_000);
    event({ type: 'tool_execution_update' });
    expect(progress).not.toHaveBeenCalled();
  });

  it('resets at each run and ignores late events after completion', async () => {
    await setup();
    commentary('Checking the deployment.');
    await vi.advanceTimersByTimeAsync(90_000);
    event({ type: 'tool_execution_update' });
    event({ type: 'agent_end' });
    await vi.advanceTimersByTimeAsync(90_000);
    event({ type: 'tool_execution_update' });
    expect(progress).toHaveBeenCalledTimes(1);
    event({ type: 'agent_start' });
    event({ type: 'tool_execution_update' });
    expect(progress).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90_000);
    event({ type: 'tool_execution_update' });
    expect(progress).toHaveBeenCalledTimes(1);
    commentary('Now checking the fix.');
    expect(progress).toHaveBeenCalledTimes(2);
  });

  it('stays quiet without fresh public commentary and never repeats a stale update', async () => {
    await setup();
    await vi.advanceTimersByTimeAsync(90_000);
    event({ type: 'tool_execution_update' });
    expect(progress).not.toHaveBeenCalled();
    commentary('I found a likely cause.');
    expect(progress).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90_000);
    event({ type: 'tool_execution_update' });
    commentary('I found a likely cause.');
    expect(progress).toHaveBeenCalledTimes(1);
    commentary('The fix passed the checks.');
    expect(progress).toHaveBeenCalledTimes(2);
  });

  it('still delivers the final reply after progress reaches the channel', async () => {
    await setup();
    await channel['pipeline'].process(key, {
      messageId: 'm1', chatId: 'user', fromUserId: 'user', chatType: 'private', isMentioned: false, text: 'Run checks',
    }, adapter);
    commentary('Checking the deployment.');
    await vi.advanceTimersByTimeAsync(90_000);
    event({ type: 'tool_execution_update' });
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.send).toHaveBeenCalledTimes(1);
    event({ type: 'agent_end' });
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.send).toHaveBeenLastCalledWith(key, 'Final answer');
    expect(adapter.send).toHaveBeenCalledTimes(2);
  });
});
