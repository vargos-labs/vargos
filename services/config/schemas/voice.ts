import { z } from 'zod';

/** Speech transport configuration in config.json; model/audio settings live in agent/settings.json. */
export const VoiceRuntimeSchema = z.object({
  host: z.ipv4().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8765),
  adapterPort: z.number().int().min(1).max(65535).default(8766),
  externalUrl: z.url().refine(value => ['ws:', 'wss:'].includes(new URL(value).protocol),
    'External speech endpoint must use ws or wss').optional(),
}).refine(value => value.port !== value.adapterPort, 'Voice and adapter ports must differ');
export type VoiceRuntimeConfig = z.infer<typeof VoiceRuntimeSchema>;
