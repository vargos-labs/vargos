import { z } from 'zod';
import { readFileSync } from 'node:fs';
import type { Bus, Service } from '../../core/types.js';
import { formatZodIssues } from '../../core/errors.js';
import {
  AgentConfigSchema,
  MemoryConfigSchema,
  resolveMemoryConfig,
  AuthSchema,
  ChannelEntrySchema,
  CronTaskSchema,
  WebhookEntrySchema,
  LinkExpandConfigSchema,
  ProvidersSchema,
  McpClientConfigSchema,
  McpServerConfigSchema,
  StorageConfigSchema,
  type ChannelEntry,
  type TelegramChannel,
  type WhatsAppChannel,
  type CronTask,
  type CronAddParams,
  type CronUpdateParams,
  type ProviderConfig,
  type Providers,
  type WebhookEntry,
  type LinkExpandConfig,
  type McpClientConfig,
  type McpServerConfig,
  type StorageConfig,
  type Auth,
  type Json,
} from './schemas/index.js';
import { getDataPaths } from '../../lib/paths.js';
import { createLogger } from '../../lib/logger.js';
import { readJson, writeJson } from '../../lib/util.js';

// ─── App config ───────────────────────────────────────────────────────────────

export const AppConfigSchema = z
  .object({
    providers: ProvidersSchema.optional(),
    agent: AgentConfigSchema.optional(),
    memory: MemoryConfigSchema.optional(),
    auth: AuthSchema,
    channels: z.array(ChannelEntrySchema).default([]),
    cron: z.object({
      tasks: z.array(CronTaskSchema).optional(),
    }).optional(),
    webhooks: z.array(WebhookEntrySchema).default([]),
    linkExpand: LinkExpandConfigSchema.default({ enabled: true, maxUrls: 3, maxCharsPerUrl: 8_000, timeoutMs: 5_000 }),
    mcp: McpClientConfigSchema.default({}),
    mcpServers: z.record(z.string(), McpServerConfigSchema).optional().describe('External MCP servers to load as bus callable events'),
    storage: StorageConfigSchema.optional(),
    media: z.object({
      audio: z.string().optional(),
      image: z.string().optional(),
    }).optional(),
    gateway: z.object({
      host: z.string().optional().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(9000),
      /** Client socket idle timeout (ms) for JSON-RPC connections */
      requestTimeoutMs: z.number().int().positive().optional().default(6e5).describe('Client socket idle timeout for JSON-RPC connections, in milliseconds. Defaults to 10 minutes.'),
    }).default({ host: '127.0.0.1', port: 9000, requestTimeoutMs: 600000 })
  })
  .passthrough();

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type {
  ChannelEntry,
  TelegramChannel,
  WhatsAppChannel,
  CronTask,
  CronAddParams,
  CronUpdateParams,
  ProviderConfig,
  Providers,
  Auth,
  WebhookEntry,
  LinkExpandConfig,
  McpClientConfig,
  McpServerConfig,
  StorageConfig,
  Json,
};

// ─── Load / save ──────────────────────────────────────────────────────────────

export function saveConfig(path: string, config: Partial<AppConfig>): void {
  writeJson(path, config);
}

// ─── ConfigService ───────────────────────────────────────────────────────────

export const BOOT_PRIORITY = 0; // must be first — all services read config during init
export class ConfigService implements Service {
  readonly name = 'config';
  private readonly log = createLogger('config');
  private readonly configFile: string;
  private readonly agentDir: string;
  private readonly agentModelsFile: string;
  private readonly agentSettingsFile: string;
  private readonly agentAuthFile: string;

  constructor() {
    const p = getDataPaths();
    this.configFile = p.configFile;
    this.agentDir = p.agentDir;
    this.agentModelsFile = p.agentModelsFile;
    this.agentSettingsFile = p.agentSettingsFile;
    this.agentAuthFile = p.agentAuthFile;
  }

  init(bus: Bus): void {
    bus.register('config.get', {
      description: 'Get the current application configuration (merged from config.json, agent/models.json, agent/settings.json).',
      schema: z.object({}),
    }, () => this.get());

    bus.register('config.set', {
      description: 'Update the application config (whole-object). Routes to the correct file (config.json, agent/models.json, agent/settings.json). Programmatic/RPC use — not a CLI or agent surface.',
      schema: z.object({}).passthrough(),
      internal: true,
    }, (p: AppConfig) => this.set(p));
  }

  dispose(): void { }

  private loadConfig(): AppConfig {
    const raw = JSON.parse(readFileSync(this.configFile, 'utf8')) as Record<string, unknown>;

    // Agent settings, providers, and auth live in separate files (settings take precedence).
    const settings = readJson<Record<string, unknown>>(this.agentSettingsFile);
    if (settings && typeof settings === 'object') {
      raw.agent = { ...(raw.agent as Record<string, unknown>), ...settings };
    }

    const models = readJson<{ providers?: unknown }>(this.agentModelsFile);
    if (models?.providers) raw.providers = models.providers;

    const auth = readJson(this.agentAuthFile);
    if (auth !== undefined) raw.auth = auth;

    raw.memory = resolveMemoryConfig(raw);

    // Validate merged config
    const result = AppConfigSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(`Invalid config at ${this.configFile}: ${formatZodIssues(result.error)}`);
    }
    return result.data;
  }

  async get(): Promise<AppConfig> {
    return this.loadConfig();
  }

  async set(params: AppConfig): Promise<AppConfig> {
    const parsed = AppConfigSchema.parse(params);

    // Split config into components by ownership
    const configForFile: Partial<AppConfig> = { ...parsed };
    const agentModels: Record<string, unknown> = {};
    let agentSettings: Record<string, unknown> = {};
    let authData: Record<string, unknown> = {};

    // Extract agent config to agent/settings.json (preserving existing fields).
    if (configForFile.agent) {
      agentSettings = { ...readJson<Record<string, unknown>>(this.agentSettingsFile), ...configForFile.agent };
      delete configForFile.agent;
    }

    // Extract auth credentials to agent/auth.json (preserving existing credentials).
    if (configForFile.auth) {
      authData = { ...readJson<Record<string, unknown>>(this.agentAuthFile), ...configForFile.auth };
      delete configForFile.auth;
    }

    // Extract providers to agent/models.json (preserving other fields).
    if (configForFile.providers) {
      agentModels.providers = configForFile.providers;
      delete configForFile.providers;
    }
    if (Object.keys(agentModels).length > 0) {
      Object.assign(agentModels, readJson<Record<string, unknown>>(this.agentModelsFile), agentModels);
    }

    // Persist to appropriate files
    saveConfig(this.configFile, configForFile);

    const writeAgentFile = (file: string, data: Record<string, unknown>) => {
      if (Object.keys(data).length > 0) writeJson(file, data);
    };

    writeAgentFile(this.agentModelsFile, agentModels);
    writeAgentFile(this.agentSettingsFile, agentSettings);
    writeAgentFile(this.agentAuthFile, authData);

    this.log.info('config updated and persisted');
    return this.loadConfig();
  }
}

export function createService(): Service {
  return new ConfigService();
}

// ── Re-exports ────────────────────────────────────────────────────────────────

export * from './schemas/index.js';
