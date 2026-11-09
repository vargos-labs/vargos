import { describe, expect, it, vi } from 'vitest';
import { ChannelEntrySchema } from '../../../config/schemas/channels.js';
import { InboundMessagePipeline } from '../../pipeline.js';
import type { Bus } from '../../../../core/types.js';
import type { AppConfig } from '../../../config/index.js';
import type { ChannelAdapter, NormalizedInboundMessage } from '../../types.js';

const message: NormalizedInboundMessage = {
  messageId: 'm1', chatId: 'group', fromUserId: 'outsider',
  chatType: 'group', isMentioned: false, text: 'background conversation',
};

describe('sentry configuration', () => {
  it('defaults to disabled for existing channels', () => {
    expect(ChannelEntrySchema.parse({ id: 'test', type: 'whatsapp' }).sentryMode).toBe(false);
  });

  it.each([false, true])('only records skipped messages when enabled=%s', async (enabled) => {
    const call = vi.fn().mockResolvedValue(undefined);
    const channel = ChannelEntrySchema.parse({ id: 'test', type: 'whatsapp', allowFrom: [], sentryMode: enabled });
    const pipeline = new InboundMessagePipeline({ call } as unknown as Bus, {
      channels: [channel], linkExpand: {},
    } as AppConfig);
    await pipeline.process('test:group', message, {} as ChannelAdapter);
    if (enabled) {
      expect(call).toHaveBeenCalledExactlyOnceWith('agent.appendMessage', {
        sessionKey: 'test:group', content: message.text,
      });
    } else {
      expect(call).not.toHaveBeenCalled();
    }
  });
});
