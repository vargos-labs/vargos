/**
 * Channel configuration schemas
 */

import { z } from 'zod';
import { AgentOptionsSchema } from './agent.js';

const ChannelBaseSchema = AgentOptionsSchema.extend({
  id:                z.string(),
  enabled:           z.boolean().default(true),
  debounceMs:        z.number().int().min(0).optional(),
  allowFrom:         z.array(z.string()).optional(),
  sentryMode:        z.boolean().optional().default(false), // retain messages that do not trigger execution
  cwd:               z.string().optional(),                  // working directory for agent sessions from this channel
});

export const TelegramChannelSchema  = ChannelBaseSchema.extend({
  type:       z.literal('telegram'),
  botToken:   z.string(),
});
export const WhatsAppChannelSchema  = ChannelBaseSchema.extend({ type: z.literal('whatsapp') });

export const ChannelEntrySchema = z.discriminatedUnion('type', [
  TelegramChannelSchema,
  WhatsAppChannelSchema,
]);

export type ChannelEntry   = z.infer<typeof ChannelEntrySchema>;
export type TelegramChannel = z.infer<typeof TelegramChannelSchema>;
export type WhatsAppChannel = z.infer<typeof WhatsAppChannelSchema>;

/** Built-in channel type names — single source of truth, derived from the union above. */
export const CHANNEL_TYPES = ChannelEntrySchema.options.map(o => o.shape.type.value) as [ChannelEntry['type'], ...ChannelEntry['type'][]];
