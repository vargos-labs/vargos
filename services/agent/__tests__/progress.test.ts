import { describe, expect, it } from 'vitest';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { AgentService } from '../index.js';
import { EmitterBus } from '../../../core/bus.js';

class ProgressRuntime extends AgentService {
  constructor(bus: EmitterBus) {
    super();
    this.bus = bus;
  }
  subscribe(session: AgentSession, key: string) {
    this.subscribeToSessionEvents(session, key);
  }
}

describe('agent progress bus events', () => {
  it('emits progress from the existing lifecycle subscription for any bus listener', () => {
    const bus = new EmitterBus();
    const runtime = new ProgressRuntime(bus);
    const progress: unknown[] = [];
    const tools: unknown[] = [];
    bus.on('agent.onProgress', event => { progress.push(event); });
    bus.on('agent.onTool', event => { tools.push(event); });
    let listener!: (event: AgentSessionEvent) => void;
    let subscriptions = 0;
    runtime.subscribe({ subscribe: (callback: typeof listener) => {
      subscriptions++;
      listener = callback;
      return () => {};
    } } as unknown as AgentSession, 'channel:conversation');
    const updates = [
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolCallId: '1', toolName: 'search', args: { query: 'example' } },
      { type: 'tool_execution_end', toolCallId: '1', toolName: 'search', result: { text: 'found' }, isError: false },
      { type: 'message_update', message: { role: 'assistant', content: [] },
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Checking sources', partial: { content: [] } } },
      { type: 'turn_start' },
    ] as unknown as AgentSessionEvent[];
    for (const update of updates) listener(update);
    expect(progress).toEqual(updates.map(event => ({ ...event, sessionKey: 'channel:conversation' })));
    expect(subscriptions).toBe(1);
    expect(tools).toHaveLength(2);
  });
});
