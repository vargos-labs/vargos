/**
 * Webhook configuration schemas
 */

import { z } from 'zod';
import { AgentOptionsSchema } from './agent.js';

export const WebhookEntrySchema = AgentOptionsSchema.extend({
  id:        z.string(),
  name:      z.string(),
  token:     z.string().optional(),  // unset → auth bypassed for this hook
  transform: z.string().optional(),  // path to JS/TS transform file
  notify:    z.array(z.string()).optional(),
});

export type WebhookEntry = z.infer<typeof WebhookEntrySchema>;
