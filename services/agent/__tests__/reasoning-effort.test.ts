import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { AppConfig } from '../../config/index.js';
import { PiAgentSettingsSchema } from '../../config/schemas/agent.js';
import { ThinkingLevelSchema } from '../../config/schemas/primitives.js';
import { EmitterBus } from '../../../core/bus.js';
import { AgentService } from '../index.js';

class ReasoningRuntime extends AgentService {
  setThinkingLevel = vi.fn();
  prompt = vi.fn(async () => {});
  constructor(bus: EmitterBus) {
    super();
    this.config = { agent: { executionTimeoutMs: 1000 } } as AppConfig;
    this['registerMethods'](bus);
  }
  protected async getOrCreateSession(): Promise<AgentSession> {
    return {
      setThinkingLevel: this.setThinkingLevel,
      prompt: this.prompt,
      state: { messages: [{ role: 'assistant', content: 'done' }] },
    } as unknown as AgentSession;
  }
}

afterEach(() => { vi.useRealTimers(); });

describe('agent.execute reasoning effort', () => {
  it.each(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])(
    'applies %s before prompting without changing global defaults', async reasoningEffort => {
      vi.useFakeTimers();
      const bus = new EmitterBus();
      const runtime = new ReasoningRuntime(bus);
      runtime.prompt.mockImplementation(async () => {
        expect(runtime.setThinkingLevel).toHaveBeenCalledWith(reasoningEffort, { persist: false });
      });
      await expect(bus.call('agent.execute', { task: 'work', reasoningEffort })).resolves.toEqual({ response: 'done' });
      expect(runtime.setThinkingLevel).toHaveBeenCalledTimes(1);
    },
  );

  it('leaves the existing reasoning level alone when omitted', async () => {
    vi.useFakeTimers();
    const bus = new EmitterBus();
    const runtime = new ReasoningRuntime(bus);
    await bus.call('agent.execute', { task: 'work' });
    expect(runtime.setThinkingLevel).not.toHaveBeenCalled();
  });

  it.each(['ultra', '', null, 42])('rejects invalid effort %s before executing', async reasoningEffort => {
    const bus = new EmitterBus();
    const runtime = new ReasoningRuntime(bus);
    await expect(bus.call('agent.execute', { task: 'work', reasoningEffort })).rejects.toThrow();
    expect(runtime.prompt).not.toHaveBeenCalled();
    expect(runtime.setThinkingLevel).not.toHaveBeenCalled();
  });

  it('shares the same thinking levels with agent settings', () => {
    for (const level of ThinkingLevelSchema.options) {
      expect(PiAgentSettingsSchema.parse({ defaultThinkingLevel: level }).defaultThinkingLevel).toBe(level);
    }
  });

  it('advertises the same validated enum to all tool surfaces', () => {
    const bus = new EmitterBus();
    new ReasoningRuntime(bus);
    const method = bus.list().find(item => item.name === 'agent.execute')!;
    expect(method.schema).toMatchObject({ properties: { reasoningEffort: {
      type: 'string', enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    } } });
  });
});
