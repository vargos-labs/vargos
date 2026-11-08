import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { EmitterBus } from '../../../core/bus.js';
import { AppConfigSchema } from '../../config/index.js';
import { ChannelService } from '../index.js';
import type { ChannelAdapter } from '../types.js';

it('delivers notifications without suppressing the task reply', async () => {
  const bus = new EmitterBus();
  bus.register('config.get', { schema: z.object({}) }, () => AppConfigSchema.parse({}));
  const service = new ChannelService();
  await service.init(bus);
  const internal = service as unknown as {
    adapters: Map<string, ChannelAdapter>;
    pipeline: { sessions: Map<string, { adapter: ChannelAdapter }> };
  };
  const send = vi.fn().mockResolvedValue(undefined);
  const adapter = { send, stop: async () => {}, stopTyping: vi.fn() } as unknown as ChannelAdapter;
  internal.adapters.set('test', adapter);
  internal.pipeline.sessions.set('test:chat', { adapter });
  try {
    await bus.call('channel.send', { sessionKey: 'test:chat', text: 'Compaction finished.' });
    expect(send).toHaveBeenCalledWith('test:chat', 'Compaction finished.');
    bus.emit('agent.onCompleted', { sessionKey: 'test:chat', success: true, response: 'Task complete.' });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('test:chat', 'Task complete.'));
    bus.emit('agent.onCompleted', { sessionKey: 'test:chat', success: true, response: 'Task complete.' });
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    await service.dispose();
  }
});
