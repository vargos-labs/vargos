/**
 * Primitive types and enums shared across config schemas
 */

import { z } from 'zod';
import type { ThinkingLevel as SdkThinkingLevel } from '@earendil-works/pi-agent-core';

// ─── JSON (recursive type) ────────────────────────────────────────────────────

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

// z.lazy is required for the recursive JSON type
export const JsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonSchema),
    z.record(z.string(), JsonSchema),
  ]),
);

// ─── Common enums ─────────────────────────────────────────────────────────────

export const ThinkingLevelSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly SdkThinkingLevel[]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;
