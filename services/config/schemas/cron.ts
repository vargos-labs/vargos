/**
 * Cron task configuration schemas
 */

import { z } from 'zod';

export const CronTaskSchema = z.object({
  id:                   z.string().min(1).describe('Unique identifier for the task'),
  name:                 z.string().min(1).describe('Human-readable task name'),
  schedule:             z.string().min(1).describe('Cron schedule expression (e.g., "0 9 * * *" for 9am daily)'),
  task:                 z.string().min(1).describe('Task prompt/instruction to execute. Supports ${WORKSPACE_DIR}, ${DATA_DIR}, etc. interpolation'),
  model:                z.string().optional().describe('Model override for this task as "provider:modelId" (e.g. "deepseek:deepseek-v4-flash"). If not set, uses the agent default.'),
  notify:               z.array(z.string()).optional().describe('Channel session keys to send results to (e.g., "whatsapp-vadi-indo:+1234567890")'),
  enabled:              z.boolean().default(true).describe('Whether the task is active'),
  activeHours:          z.array(z.number().min(0).max(23)).optional().describe('Active hours window [startHour, endHour] for conditional execution (0-23)'),
  activeHoursTimezone:  z.string().optional().describe('IANA timezone for activeHours interpretation (e.g., "Australia/Sydney")'),
});

export const CronAddSchema    = CronTaskSchema.omit({ id: true, enabled: true });
export const CronUpdateSchema = CronTaskSchema.partial().required({ id: true });

export type CronTask       = z.infer<typeof CronTaskSchema>;
export type CronAddParams  = z.infer<typeof CronAddSchema>;
export type CronUpdateParams = z.infer<typeof CronUpdateSchema>;
