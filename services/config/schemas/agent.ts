/**
 * Agent configuration schemas
 *
 * Combines Vargos-specific fields with PiAgent's Settings from ~/.vargos/agent/settings.json
 * See @earendil-works/pi-coding-agent SettingsManager for full field list.
 */

import { z } from 'zod';
import { ThinkingLevelSchema } from './primitives.js';

/** Optional per-agent overrides shared by personas and execution triggers. */
export const AgentOptionsSchema = z.object({
  model: z.string().optional().describe('Model override as provider:modelId; omit to keep the current default.'),
  reasoningEffort: ThinkingLevelSchema.optional().describe('Reasoning effort; omit to keep the current setting.'),
  allowedTools: z.array(z.string()).optional().describe('Bus-tool glob whitelist narrowing persona/default tools. Empty or omitted adds no restriction. Built-in Pi tools are unaffected.'),
  skills: z.array(z.string()).optional().describe('Discovered skill-name glob whitelist narrowing persona/default skill discovery. Empty or omitted adds no restriction.'),
});
export type AgentOptions = z.infer<typeof AgentOptionsSchema>;

export const AgentExecuteSchema = AgentOptionsSchema.extend({
  task: z.string().describe('The task to execute or question to answer.'),
  taskName: z.string().trim().min(1).max(160).optional().describe('MCP conversation name; reused names continue a conversation, omitted names use a timestamp.'),
  cwd: z.string().optional().describe('Working directory; defaults to the workspace.'),
}).passthrough();
export type AgentExecuteParams = z.infer<typeof AgentExecuteSchema> & { sessionKey?: string };

// ─── PiAgent Settings Schemas ──────────────────────────────────────────────────

export const CompactionSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  reserveTokens: z.number().int().optional(),
  keepRecentTokens: z.number().int().optional(),
}).optional();

export const BranchSummarySettingsSchema = z.object({
  reserveTokens: z.number().int().optional(),
}).optional();

export const RetrySettingsSchema = z.object({
  enabled: z.boolean().optional(),
  maxRetries: z.number().int().optional(),
  baseDelayMs: z.number().int().optional(),
  maxDelayMs: z.number().int().optional(),
}).optional();

export const TerminalSettingsSchema = z.object({
  showImages: z.boolean().optional(),
}).optional();

export const ImageSettingsSchema = z.object({
  autoResize: z.boolean().optional(),
  blockImages: z.boolean().optional(),
}).optional();

export const ThinkingBudgetsSettingsSchema = z.object({
  minimal: z.number().int().optional(),
  low: z.number().int().optional(),
  medium: z.number().int().optional(),
  high: z.number().int().optional(),
}).optional();

export const MarkdownSettingsSchema = z.object({
  codeBlockIndent: z.string().optional(),
}).optional();

export const PackageSourceSchema = z.union([
  z.string(),
  z.object({
    source: z.string(),
    extensions: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
    prompts: z.array(z.string()).optional(),
    themes: z.array(z.string()).optional(),
  }),
]);

export const PiAgentSettingsSchema = z.object({
  lastChangelogVersion: z.string().optional(),
  defaultThinkingLevel: ThinkingLevelSchema.optional(),
  steeringMode: z.enum(['all', 'one-at-a-time']).optional(),
  followUpMode: z.enum(['all', 'one-at-a-time']).optional(),
  theme: z.string().optional(),
  compaction: CompactionSettingsSchema,
  branchSummary: BranchSummarySettingsSchema,
  retry: RetrySettingsSchema,
  hideThinkingBlock: z.boolean().optional(),
  shellPath: z.string().optional(),
  quietStartup: z.boolean().optional(),
  shellCommandPrefix: z.string().optional(),
  collapseChangelog: z.boolean().optional(),
  packages: z.array(PackageSourceSchema).optional(),
  extensions: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  prompts: z.array(z.string()).optional(),
  themes: z.array(z.string()).optional(),
  enableSkillCommands: z.boolean().optional(),
  terminal: TerminalSettingsSchema,
  images: ImageSettingsSchema,
  enabledModels: z.array(z.string()).optional(),
  doubleEscapeAction: z.enum(['fork', 'tree', 'none']).optional(),
  thinkingBudgets: ThinkingBudgetsSettingsSchema,
  editorPaddingX: z.number().int().optional(),
  autocompleteMaxVisible: z.number().int().optional(),
  showHardwareCursor: z.boolean().optional(),
  markdown: MarkdownSettingsSchema,
}).strict(); // Strict to catch typos or unexpected fields

export type PiAgentSettings = z.infer<typeof PiAgentSettingsSchema>;

// ─── Vargos Agent Config ───────────────────────────────────────────────────────

/** Speech pipeline settings stored alongside agent settings, never API keys. */
export const VoiceSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.string().min(1),
  model: z.string().min(1),
  stt: z.object({
    baseUrl: z.url(),
    model: z.string().min(1),
    language: z.string().default('English'),
  }).strict(),
  tts: z.object({
    baseUrl: z.url(),
    model: z.string().min(1),
    voice: z.string().default('jarvis'),
    referenceAudio: z.string().default('agent/voice-templates/jarvis.wav')
      .describe('Absolute path, or path relative to the Vargos data directory.'),
    referenceText: z.string().min(1),
    language: z.string().default('English'),
  }).strict(),
}).strict();

export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

export const AgentConfigSchema = PiAgentSettingsSchema.extend({
  voice: VoiceSettingsSchema.optional(),
  executionTimeoutMs: z.number().int().positive().optional().default(300 * 60 * 1000).describe('Max execution time for agent tasks in milliseconds. Default is 5 hours (300 minutes).'),
  media: z.object({
    audio: z.string().optional(),
    image: z.string().optional(),
    maxExtractChars: z.number().int().positive().optional().describe('Max characters of extracted media text (documents, audio transcripts) injected into the agent context. Over the limit the full text is saved next to the file and only the head is injected. Default 100000 (~25k tokens), tune down for small-context models.'),
  }).optional(),
}).passthrough(); // Allow custom fields from Pi Agent

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
