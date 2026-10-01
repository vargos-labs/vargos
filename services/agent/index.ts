/**
 * Agent — PiAgent-powered runtime
 *
 * Features:
 * - PiAgent session persistence
 * - PiAgent ResourceLoader for skills/prompts
 * - Debug mode for inspecting tools, prompts, history
 * - Streaming events passthrough to bus (agent.onDelta, agent.onTool, agent.onCompleted)
 */

import { z } from 'zod';
import path from 'node:path';
import type { Bus, Service, Json } from '../../core/types.js';
import type { AppConfig } from '../../services/config/index.js';
import { createLogger } from '../../lib/logger.js';
import { withTimeout } from '../../lib/util.js';
import { interpolatePrompt } from './prompt-interpolate.js';
import { truncate } from '../../lib/util.js';
import { existsSync, promises as fs } from 'node:fs';
import { getDataPaths } from '../../lib/paths.js';
import { parseSessionKey, isSubagentSession, rootSessionKey } from '../../lib/session-key.js';

// Pi SDK imports
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  ModelRuntime,
  ModelRegistry,
  DefaultResourceLoader,
  type AgentSession,
  type ToolDefinition,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
} from '@earendil-works/pi-coding-agent';

/** A resolved Pi SDK model (the type carried by `AgentSession.model`). */
type ResolvedModel = NonNullable<AgentSession['model']>;

// PiAgent event types for type-safe event mapping
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

import { createCustomTools } from './tools.js';
import { loadChannelPersona, loadSubagentPersona } from './persona.js';
import { resolveSkillPaths } from './skills.js';
import { matchesGlob } from '../../lib/glob-match.js';
import { toMessage } from '../../lib/error.js';

const log = createLogger('agent');
const DEFAULT_EXECUTION_TIMEOUT_MS = 300 * 60 * 1000; // 5 hours

const COMPACTION_MESSAGES = [
  "Our conversation's getting long — giving my memory a quick tidy. Back in a sec! 🗂️",
  "Pausing to condense what we've covered so far. One moment...",
  "Summarizing our chat history to stay sharp. Won't be long!",
  "Our thread's growing — archiving earlier context so I stay focused. Just a moment.",
  "Quick memory refresh in progress. Hang tight! 🔄",
  "Archiving the earlier parts of our conversation. Be right back...",
  "Doing a context repack to stay on top of things. Give me a sec!",
  "Our chat history's getting full — tidying it up. Back shortly.",
  "Taking a breath to consolidate what we've discussed. One sec...",
  "Memory housekeeping in progress. Won't be a moment! 📚",
] as const;

function randomCompactionMessage(): string {
  return COMPACTION_MESSAGES[Math.floor(Math.random() * COMPACTION_MESSAGES.length)];
}

/**
 * Overflow-compaction loop guard: max no-progress overflow compactions per burst before
 * the "Compaction complete" follow-up nudge stops (which is what pumps the loop — each
 * nudge 400s on the unchanged over-limit prompt, re-triggering compaction). See
 * subscribeToSessionEvents (compaction_start / compaction_end).
 */
const OVERFLOW_COMPACTION_BREAK_AFTER = 3;

/** Narrow read-only view of a Pi SDK assistant message (see extractFinalAssistant). */
interface AssistantMessageView {
  role: string;
  stopReason?: string;
  errorMessage?: string;
  content?: string | Array<{ type: string; text?: string }>;
}

// ── AgentService ─────────────────────────────────────────────────────────────

export const BOOT_PRIORITY = 50; // core agent — registers agent.execute
export class AgentService implements Service {
  readonly name = 'agent';
  protected bus!: Bus;
  protected config!: AppConfig;
  protected sessions = new Map<string, AgentSession>();
  /** sessionKey → epoch ms when the session entered the cache (for agent.status). */
  protected sessionMeta = new Map<string, number>();
  protected activeRuns = new Set<string>();
  /** sessionKey → consecutive overflow-compaction burst (loop guard, see subscribeToSessionEvents). */
  protected overflowBursts = new Map<string, { ends: number; noticed: boolean; broken: boolean }>();

  protected agentDir!: string;
  protected modelRuntime!: ModelRuntime;
  protected modelRegistry!: ModelRegistry;
  protected settings!: SettingsManager;

  async init(bus: Bus): Promise<void> {
    this.bus = bus;
    this.config = await bus.call<AppConfig>('config.get', {});

    const paths = getDataPaths();
    this.agentDir = paths.agentDir;

    // Use ~/.vargos/agent for auth and models (override PiAgent defaults)
    const authJsonPath = paths.agentAuthFile;
    const modelsJsonPath = paths.agentModelsFile;

    this.modelRuntime = await ModelRuntime.create({ authPath: authJsonPath, modelsPath: modelsJsonPath });
    this.modelRegistry = new ModelRegistry(this.modelRuntime);

    const modelError = this.modelRuntime.getError();
    if (modelError) {
      throw new Error(`Failed to load models from ${modelsJsonPath}: ${modelError}`);
    }

    this.settings = SettingsManager.create(paths.dataDir, this.agentDir);
    this.settings.applyOverrides({
      retry: {
        enabled: true,
        maxRetries: 3,
        baseDelayMs: 1000,
        provider: { timeoutMs: 120000, maxRetries: 3, maxRetryDelayMs: 30000 },
      },
    });

    this.registerMethods(bus);
    await this.persistRetrySettings();
  }

  private registerMethods(bus: Bus): void {
    bus.register('agent.execute', {
      description: 'Executes a task with the agent, optionally delegating to a subagent.',
      // passthrough keeps `sessionKey` (auto-injected by the tool wrapper, supplied by
      // direct callers) alive through validation without advertising it as a tool param.
      schema: z.object({
        task: z.string().describe('The task to execute.'),
        cwd: z.string().optional().describe('Working directory for the agent — defaults to workspace dir.'),
        model: z.string().optional().describe('Optional model override as "provider:modelId" (e.g. "anthropic:claude-opus-4"). Omit to use the agent default.'),
      }).passthrough(),
      cli: { positional: ['task'] },
    }, (p) => this.execute(p));

    bus.register('agent.appendMessage', {
      description: 'Append a message to a session\'s history without executing the agent.',
      schema: z.object({ sessionKey: z.string(), content: z.string() }),
      internal: true,
    }, (p) => this.appendMessage(p));

    bus.register('agent.status', {
      description: 'Return the agent session inventory (state, parent links, model). Pass sessionKey to scope to one session and its subagents.',
      schema: z.object({ sessionKey: z.string().optional() }),
      cli: { positional: ['sessionKey'] },
      live: true, // session state lives in the daemon; a local stack is always empty
    }, (p) => this.status(p));
  }

  dispose(): void {
    this.sessions.forEach((session) => session.dispose());
    this.sessions.clear();
    this.sessionMeta.clear();
  }

  /**
   * Persist retry settings to disk during boot
   */
  private async persistRetrySettings() {
    try {
      const settingsPath = path.join(this.agentDir, 'settings.json');
      // A fresh install has no settings.json yet — start from empty and write one,
      // rather than warning and leaving retry settings unpersisted.
      const currentSettings = await fs.readFile(settingsPath, 'utf-8')
        .then(data => JSON.parse(data) as Record<string, unknown>)
        .catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return {};
          throw err;
        });
      const updated = {
        ...currentSettings,
        retry: {
          enabled: true,
          maxRetries: 3,
          baseDelayMs: 1000,
          provider: {
            timeoutMs: 120000,
            maxRetries: 3,
            maxRetryDelayMs: 30000,
          },
        },
      };
      await fs.writeFile(settingsPath, JSON.stringify(updated, null, 2), 'utf-8');
      log.debug('Retry settings persisted to', settingsPath);
    } catch (err) {
      log.warn(`Retry settings persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * agent.execute — Run a task. `sessionKey` is auto-injected by the tool wrapper when
   * the agent calls this as a tool; direct callers (channels, cron, webhooks, RPC)
   * supply it. It survives validation via the schema's .passthrough().
   */
  private async execute(params: { sessionKey?: string; task: string; cwd?: string; model?: string }): Promise<{ response: string }> {
    // Channels/cron/webhooks and the agent-tool wrapper always supply a sessionKey; a bare
    // `vargos agent execute "<task>"` does not, so default to a shared ad-hoc CLI session.
    const sessionKey = params.sessionKey || 'cli:adhoc';

    log.debug(`[${sessionKey}] execute start`);

    // Fall back to the session's default model when the override is missing or unknown,
    // instead of failing the run (agents sometimes pass an ill-formed or stale model id).
    let model = params.model;
    if (model && !this.isValidModel(model)) {
      log.warn(`[${sessionKey}] invalid model override "${model}"; expected provider:modelId, using default`);
      model = undefined;
    }

    const task = interpolatePrompt(params.task, { SESSION_KEY: sessionKey }).trim();

    const session = await this.getOrCreateSession(sessionKey, { cwd: params.cwd, model });

    const timeoutMs = this.config.agent?.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;

    this.activeRuns.add(sessionKey);
    const startTime = Date.now();
    const modelTag = `${session.model?.provider}:${session.model?.id}`;
    try {
      await withTimeout(session.prompt(task, { streamingBehavior: 'steer' }), timeoutMs, `Agent execution timeout after ${timeoutMs}ms`);
    } finally {
      this.activeRuns.delete(sessionKey);
    }

    const { content, error } = this.extractFinalAssistant(session, sessionKey);

    if (error) {
      log.error(`[${sessionKey}] execute failed model=${modelTag}: ${error}`);
      throw new Error(error);
    }

    const elapsed = Date.now() - startTime;
    log.info(`[${sessionKey}] execute ok chars=${content.length} elapsedMs=${elapsed} model=${modelTag}`);
    return { response: content };
  }

  /**
   * agent.appendMessage — Append message to session JSONL without executing agent.
   * Records inbound messages in session history (observe-only for non-whitelisted).
   * Internal only — not exposed as an agent tool.
   */
  private async appendMessage(params: { sessionKey: string; content: string }): Promise<void> {
    const session = await this.getOrCreateSession(params.sessionKey);
    const sessionFile = session.sessionManager.getSessionFile();

    if (!sessionFile) {
      log.debug(`[${params.sessionKey}] append skipped: no session file`);
      return;
    }

    log.debug(`[${params.sessionKey}] append message without execution`);

    const isExecuting = this.activeRuns.has(params.sessionKey);

    session.sessionManager.appendMessage({
      timestamp: Date.now(),
      role: 'user',
      content: params.content,
    });

    if (!isExecuting) {
      // Manually force write to disk so other Vargos instances on the NAS/cluster can see the history
      session.exportToJsonl(sessionFile);

      // We MUST wipe the session from the local Vargos cache if the agent is not executing.
      // Why? The Pi SDK deliberately defers JSONL file creation until the FIRST assistant message.
      // By forcing `exportToJsonl`, we circumvented Pi SDK and created the file early on disk.
      // But this in-memory AgentSession's `flushed` flag remains `false`.
      // If kept in cache, the NEXT time this node executes the LLM, the Pi SDK will attempt
      // an exclusive create (`openSync(..., "wx")`) and violently crash with `EEXIST` because 
      // the file is already there! Evicting cache forces full reload via `continueRecent()`.
      session.dispose();
      this.sessions.delete(params.sessionKey);
      this.sessionMeta.delete(params.sessionKey);
    }
  }

  /**
   * agent.status — Inventory cached sessions (parents, subagents, idle) with their
   * run state, parent relationship, and model. When `sessionKey` is given, the result
   * is scoped to that session and its subagents — letting a parent observe its own
   * subtree. `activeRuns` is kept for callers that only need the executing keys.
   */
  private async status(params: { sessionKey?: string }) {
    const scope = params.sessionKey;
    const inScope = (key: string) => !scope || key === scope || key.startsWith(`${scope}:subagent:`);

    const sessions = Array.from(this.sessions.entries())
      .filter(([key]) => inScope(key))
      .map(([sessionKey, session]) => ({
        sessionKey,
        state: this.activeRuns.has(sessionKey) ? 'running' as const : 'idle' as const,
        parentKey: isSubagentSession(sessionKey) ? rootSessionKey(sessionKey) : undefined,
        model: session.model ? `${session.model.provider}:${session.model.id}` : undefined,
        startedAt: this.sessionMeta.get(sessionKey),
      }));

    const activeRuns = Array.from(this.activeRuns).filter(inScope);
    return { sessions, activeRuns };
  }

  /**
   * Get or create AgentSession for sessionKey.
   * Uses SessionManager.continueRecent() to load the latest session file,
   * preserving conversation history across restarts.
   */
  protected async getOrCreateSession(sessionKey: string, options?: { cwd?: string; model?: string }): Promise<AgentSession> {
    const cached = this.sessions.get(sessionKey);
    if (cached) {
      await this.applyModelOverride(cached, sessionKey, options?.model);
      return cached;
    }

    const paths = getDataPaths();
    const effectiveCwd = options?.cwd ?? paths.dataDir;

    const sessionDir = path.join(paths.sessionsDir, sessionKey.replace(/:/g, path.sep));
    // Use continueRecent to find and load the latest session file (preserves history).
    // Falls back to create() if no existing session file is found.
    let sessionManager: ReturnType<typeof SessionManager.create>;
    try {
      sessionManager = SessionManager.create(effectiveCwd, sessionDir);
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST') {
        // File was created by another code path (e.g. concurrent message for same session).
        // Fall back to continueRecent which opens existing files gracefully.
        log.debug(`[${sessionKey}] session create hit EEXIST; using continueRecent`);
        sessionManager = SessionManager.continueRecent(effectiveCwd, sessionDir);
      } else {
        throw err;
      }
    }

    await fs.mkdir(sessionDir, { recursive: true });
    await fs.mkdir(this.agentDir, { recursive: true });

    const persona = await this.loadPersonaIfChannel(sessionKey);
    const customTools = await this.getCustomTools(sessionKey, persona?.meta.allowedTools);
    const rawSystemPrompt = await this.getSystemPrompt(sessionKey, persona?.body);
    const resourceLoader = await this.createResourceLoader(rawSystemPrompt, effectiveCwd, sessionKey);

    log.debug(`[${sessionKey}] session created tools=${customTools.length} promptChars=${rawSystemPrompt?.length ?? 0}`);

    // Apply the per-call/channel model override at creation time, when provided and known.
    const model = this.resolveModel(options?.model);

    const { session } = await this.createPiSession({
      cwd: effectiveCwd,
      agentDir: this.agentDir,
      sessionManager,
      settingsManager: this.settings,
      modelRuntime: this.modelRuntime,
      customTools,
      resourceLoader,
      ...(model && { model }),
    });

    if (process.env.LOG_LEVEL === 'debug') {
      const debugDir = path.join(sessionDir, '.debug');
      if (!existsSync(debugDir)) {
        await fs.mkdir(debugDir, { recursive: true });
      }

      log.debug(`[${sessionKey}] debug files dir=${debugDir}`);
      await fs.writeFile(path.join(debugDir, `systemPrompt.md`), session.systemPrompt ?? '', 'utf-8');
    }

    this.subscribeToSessionEvents(session, sessionKey);

    this.sessions.set(sessionKey, session);
    this.sessionMeta.set(sessionKey, Date.now());
    return session;
  }

  /**
   * Create the underlying Pi SDK session. Isolated as a seam so tests can
   * substitute a fake session without the SDK's model/auth machinery.
   */
  protected createPiSession(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> {
    return createAgentSession(options);
  }

  /**
   * Switch a cached session's model when an override differs from the current one.
   * Unknown/missing overrides are a no-op — the session keeps its existing model.
   */
  private async applyModelOverride(session: AgentSession, sessionKey: string, modelSpec?: string): Promise<void> {
    const resolved = this.resolveModel(modelSpec);
    if (!resolved) return;
    if (session.model?.provider === resolved.provider && session.model?.id === resolved.id) return;
    await session.setModel(resolved);
    log.info(`[${sessionKey}] model set ${resolved.provider}:${resolved.id}`);
  }

  /**
   * Resolve a `provider:modelId` override to a Pi SDK model, or undefined if unknown.
   *
   * Both sides may contain a colon: provider ids can (local vLLM providers are
   * registered as e.g. "vargos-110:vllm") and so can model ids (the built-in
   * catalog ships ids like "amazon-bedrock:qwen.qwen3-235b-a22b-2507-v1:0").
   * A single fixed split therefore can't cover both, so probe every colon
   * boundary — longest provider first — and return the first split the
   * registry actually resolves.
   */
  private resolveModel(modelSpec?: string): ResolvedModel | undefined {
    if (!modelSpec) return undefined;
    for (let sep = modelSpec.lastIndexOf(':'); sep > 0; sep = modelSpec.lastIndexOf(':', sep - 1)) {
      const model = this.modelRegistry.find(modelSpec.slice(0, sep), modelSpec.slice(sep + 1));
      if (model) return model;
    }
    return undefined;
  }

  /**
   * Subscribe to PiAgent sessionsubscription - emit to bus for streaming + debug logging.
   */
  protected subscribeToSessionEvents(session: AgentSession, sessionKey: string): void {
    session.subscribe((event: AgentSessionEvent) => {
      // Switching on event.type directly lets TypeScript narrow the union per-case,
      // so each branch can access typed fields without casting.
      switch (event.type) {
        case 'tool_execution_start': {
          if (event.toolName) {
            this.bus.emit('agent.onTool', {
              sessionKey,
              toolName: event.toolName,
              phase: 'start',
              args: (event.args ?? {}) as Json,
            });
          }
          break;
        }
        case 'tool_execution_end': {
          if (event.toolName) {
            this.bus.emit('agent.onTool', {
              sessionKey,
              toolName: event.toolName,
              phase: 'end',
              result: (event.result ?? {}) as Json,
            });
          }
          break;
        }
        case 'message_update': {
          // delta/text are carried at the top level in practice but not in the declared type.
          const e = event as typeof event & { delta?: string; text?: string };
          const delta = e.delta || e.text || '';
          if (delta) {
            this.bus.emit('agent.onDelta', { sessionKey, chunk: delta });
          }
          break;
        }
        case 'turn_end': {
          break;
        }
        case 'agent_end': {
          const { content, error } = this.extractFinalAssistant(session, sessionKey);
          if (error) {
            const model = session.model?.id ?? 'unknown';
            log.error(`[${sessionKey}] event agent_end error model=${model}: ${error}`);
            this.bus.emit('agent.onCompleted', { sessionKey, success: false, error });
          } else {
            this.overflowBursts.delete(sessionKey);
            log.debug(`[${sessionKey}] event agent_end emitted chars=${content.length}`);
            this.bus.emit('agent.onCompleted', { sessionKey, success: true, response: content });
          }
          break;
        }
        case 'compaction_start': {
          log.info(`[${sessionKey}] compaction start reason=${event.reason}`);
          const isOverflow = event.reason === 'overflow';
          let burst: { ends: number; noticed: boolean; broken: boolean } | undefined;
          if (isOverflow) {
            burst = this.overflowBursts.get(sessionKey) ?? { ends: 0, noticed: false, broken: false };
            this.overflowBursts.set(sessionKey, burst);
            if (burst.broken) {
              log.error(`[${sessionKey}] overflow compaction recurred after loop break — prompt is still over context; session history needs a fresh start to recover`);
            }
          }
          const { type } = parseSessionKey(sessionKey);
          const isChannel = this.config.channels.some(c => c.id === type);
          if (isChannel) {
            // During an overflow burst the SDK re-compacts every failed inference; without
            // this guard each one sent the user another "compacting memory" notice (194 in
            // one 16-minute loop, Sep 16). Notify once per burst instead.
            if (!burst || !burst.noticed) {
              if (burst) burst.noticed = true;
              this.bus.call('channel.send', { sessionKey, text: randomCompactionMessage() })
                .catch(err => log.debug(`[${sessionKey}] compaction notice send failed: ${toMessage(err)}`));
            }
          }
          break;
        }
        case 'compaction_end': {
          if (event.aborted) {
            const msg = `compaction failed: ${event.errorMessage ?? 'unknown'}`;
            if (event.willRetry) log.warn(`[${sessionKey}] ${msg}; retry=true`);
            else log.error(`[${sessionKey}] ${msg}; retry=false`);
          } else {
            const before = event.result?.tokensBefore;
            log.info(`[${sessionKey}] compaction done${before !== undefined ? ` tokensBefore=${before}` : ''}`);
            // Overflow loop guard: a recent message (e.g. binary bytes injected as text)
            // that compaction cannot summarize keeps the prompt over the model's context
            // limit. Without a break, every "Compaction complete" follow-up nudge 400s and
            // re-triggers compaction forever. After N no-progress overflow compactions in
            // one burst, stop nudging and surface it.
            const burst = this.overflowBursts.get(sessionKey);
            if (burst) {
              if (burst.broken) {
                // Loop already broken — skip the nudge (it just 400s and re-triggers compaction).
                log.debug(`[${sessionKey}] overflow compaction end after loop break; skipping follow-up nudge`);
                break;
              }
              if (burst.ends + 1 >= OVERFLOW_COMPACTION_BREAK_AFTER) {
                burst.broken = true;
                log.error(`[${sessionKey}] overflow compaction loop broken after ${burst.ends + 1} compactions without progress — prompt is still over context. Next agent run on this session will likely fail until the history is trimmed or the session is started fresh.`);
                break;
              }
              burst.ends += 1;
            }
            // Use prompt (not followUp): followUp throws when the agent is idle (e.g. a
            // pre-prompt threshold check), silently dropping the nudge. prompt with
            // streamingBehavior:'followUp' works in both states — queues a follow-up turn
            // while streaming, or triggers one immediately when idle.
            session.prompt('Compaction complete. Your memory has been tidied up and is ready to continue.', { streamingBehavior: 'followUp' })
              .catch(err => log.debug(`[${sessionKey}] compaction follow-up failed: ${toMessage(err)}`));
          }
          break;
        }
        default: {
          break;
        }
      }
    });
  }

  /**
   * Create ResourceLoader. PiAgent's DefaultResourceLoader handles skills, themes, and
   * prompt templates. We override systemPrompt with our Vargos bootstrap files.
   */
  protected async createResourceLoader(systemPromptOverride?: string, cwd?: string, sessionKey?: string): Promise<DefaultResourceLoader> {
    const paths = getDataPaths();
    const effectiveCwd = cwd ?? paths.workspaceDir;
    // Only workspace + cwd here — Pi SDK already auto-loads <agentDir>/skills and <cwd>/.pi/skills.
    const skillPaths = resolveSkillPaths(paths.workspaceDir, ...(cwd ? [cwd] : []));

    const resourceLoader = new DefaultResourceLoader({
      cwd: effectiveCwd,
      agentDir: this.agentDir,
      settingsManager: this.settings,
      extensionFactories: [],
      noExtensions: true,
      additionalSkillPaths: skillPaths,
      noSkills: false,
      ...(systemPromptOverride && { systemPrompt: systemPromptOverride }),
    });

    await resourceLoader.reload();
    const { skills } = resourceLoader.getSkills();
    log.debug(`${sessionKey ? `[${sessionKey}] ` : ''}resource loader ready skills=${skills.length}`);
    return resourceLoader;
  }

  /**
   * Load persona for the given sessionKey.
   * - Subagent sessions: load `agents/subagent.md` (preamble + allowedTools whitelist).
   * - Channel sessions: load `agents/<channelId>.md` (persona + tool filter).
   * - Cron / CLI / other types: return null (no persona override applied).
   */
  private async loadPersonaIfChannel(sessionKey: string) {
    if (isSubagentSession(sessionKey)) return loadSubagentPersona();
    const { type } = parseSessionKey(sessionKey);
    const isChannel = this.config.channels.some(c => c.id === type);
    if (!isChannel) return null;
    return loadChannelPersona(type);
  }

  /**
   * Build system prompt.
   * - Subagent sessions: return the persona body from `agents/subagent.md`.
   *   No bootstrap files (AGENTS.md, SOUL.md, TOOLS.md) are loaded — the parent's
   *   task description is the subagent's sole context.
   * - Parent/other sessions: merge AGENTS.md + SOUL.md + TOOLS.md from workspace/cwd,
   *   then append channel persona body if provided.
   */
  private async getSystemPrompt(sessionKey: string, personaBody?: string): Promise<string | undefined> {
    if (isSubagentSession(sessionKey)) {
      return personaBody?.trim() || undefined;
    }

    const bootstrapFiles = ['AGENTS.md', 'SOUL.md', 'TOOLS.md'];
    const maxCharsPerFile = 6000;

    const dirs = [getDataPaths().workspaceDir];

    const filePathsToLoad: Array<{ dir: string; filename: string; path: string }> = [];
    for (const dir of dirs) {
      for (const filename of bootstrapFiles) {
        filePathsToLoad.push({ dir, filename, path: path.join(dir, filename) });
      }
    }

    const fileContents = await Promise.all(
      filePathsToLoad.map(async (item) => {
        try {
          const content = await fs.readFile(item.path, 'utf-8');
          const truncated = truncate(content, maxCharsPerFile);
          log.debug(`[${sessionKey}] bootstrap loaded file=${item.path} chars=${truncated.length}`);
          return {
            label: `<!-- ${item.dir}/${item.filename} -->`,
            content: truncated.trim(),
          };
        } catch {
          log.debug(`[${sessionKey}] bootstrap missing file=${item.path}`);
          return null;
        }
      }),
    );

    const sections: string[] = [];
    for (const result of fileContents) {
      if (result) sections.push(result.label, result.content, '');
    }

    log.debug(`[${sessionKey}] bootstrap ready files=${sections.filter(s => s.startsWith('<!--')).length} chars=${sections.join('\n').length}`);
    if (personaBody) {
      sections.push('<!-- channel persona -->', '<channel-persona>', personaBody.trim(), '</channel-persona>');
    }

    if (sections.length === 0) {
      log.debug(`[${sessionKey}] bootstrap empty; using PiAgent default`);
      return undefined;
    }

    const prompt = sections.join('\n');
    return interpolatePrompt(prompt, { SESSION_KEY: sessionKey });
  }

  /**
   * Load custom tools from bus callable events. When `allowedPatterns` is provided
   * (from a channel persona), filter the tool list down to names matching at least
   * one glob pattern. Empty/undefined patterns = all tools allowed.
   */
  protected async getCustomTools(sessionKey: string, allowedPatterns?: string[]): Promise<ToolDefinition[]> {
    const tools = createCustomTools(sessionKey, this.bus);
    if (!allowedPatterns?.length) return tools;
    // Match on `label` (original event name with dots, e.g. "memory.search")
    // rather than `name` (sanitized with dashes, e.g. "memory-search"),
    // so that frontmatter patterns like "memory.*" work as expected.
    return tools.filter(t => allowedPatterns.some(p => matchesGlob(p, t.label)));
  }

  /**
   * Validate model override if provided.
   */
  private isValidModel(modelSpec: string): boolean {
    return !!this.resolveModel(modelSpec);
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Extract the final assistant message: text content + error (when stopReason === 'error').
   * Pi SDK records inference failures (e.g. missing API key) as assistant messages with
   * empty content and `errorMessage` populated, instead of throwing — without inspecting
   * `stopReason`/`errorMessage` here, those would surface as silent empty completions.
   */
  private extractFinalAssistant(session: AgentSession, sessionKey?: string): { content: string; error?: string } {
    const messages = session.state.messages as AssistantMessageView[];

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role !== 'assistant') continue;

      let error: string | undefined;
      if (msg.stopReason === 'error') {
        error = msg.errorMessage ?? 'unknown inference error';
        // Log full message details for debugging connection/auth issues
        log.debug(`${sessionKey ? `[${sessionKey}] ` : ''}assistant error details`, {
          stopReason: msg.stopReason,
          errorMessage: msg.errorMessage,
          model: session.model?.id,
          messageCount: messages.length,
        });
      }

      let content = '';
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = msg.content
          .filter(block => block.type === 'text')
          .map(block => block.text || '')
          .filter(Boolean)
          .join('\n');
      }

      return error ? { content, error } : { content };
    }

    return { content: '' };
  }

}

export function createService(): Service {
  return new AgentService();
}
