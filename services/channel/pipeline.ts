/**
 * Inbound message pipeline — core policy orchestrator and owner of in-flight runs.
 *
 * Handles: link expansion, access control, agent execution, typing and reaction
 * lifecycle, and reply delivery when the agent finishes.
 */

import type { Bus } from '../../core/types.js';
import type { AppConfig } from '../../services/config/index.js';
import type { NormalizedInboundMessage, ChannelAdapter } from './types.js';
import { createLogger } from '../../lib/logger.js';
import { toMessage } from '../../lib/error.js';
import { parseChannelTarget } from '../../lib/session-key.js';
import { isAllowed, shouldExecute } from './access.js';
import { expandLinks } from './link-expand.js';
import { StatusReactionController } from './status-reactions.js';

const log = createLogger('channels-pipeline');
const TOOL_ARGS_PREVIEW_CHARS = 160;

export type AgentToolPayload =
  | { sessionKey: string; toolName: string; phase: 'start'; args: unknown }
  | { sessionKey: string; toolName: string; phase: 'end'; result: unknown };

export type AgentCompletedPayload =
  | { sessionKey: string; success: true; response: string }
  | { sessionKey: string; success: false; error: string };

interface PipelineSession {
  adapter: ChannelAdapter;
  reactionController?: StatusReactionController;
  replied: boolean;    // true if the agent called channel.send itself
  completed?: boolean; // true once agent.onCompleted handled it — guards against double-send
}

function formatToolLog(payload: AgentToolPayload): string {
  const base = `agent.onTool: ${payload.sessionKey} ${payload.toolName} ${payload.phase}`;
  if (payload.phase !== 'start') return base;

  const args = JSON.stringify(payload.args);
  if (!args || args === '{}') return base;

  const preview = args.length > TOOL_ARGS_PREVIEW_CHARS
    ? `${args.slice(0, TOOL_ARGS_PREVIEW_CHARS)}...`
    : args;

  return `${base} args=${preview}`;
}

export class InboundMessagePipeline {
  private readonly sessions = new Map<string, PipelineSession>();

  constructor(
    private readonly bus: Bus,
    private readonly config: AppConfig,
  ) { }

  /** Record that the agent delivered its own reply, so completion does not send it twice. */
  markReplied(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) session.replied = true;
  }

  /**
   * Process a normalized inbound message through the policy pipeline.
   * Handles: link expansion, access control, agent execution, typing indicators.
   */
  async process(
    sessionKey: string,
    message: NormalizedInboundMessage,
    adapter: ChannelAdapter,
  ): Promise<void> {
    const target = parseChannelTarget(sessionKey);
    if (!target) {
      log.debug(`invalid session key: ${sessionKey}`);
      return;
    }

    const channelEntry = this.config.channels.find(c => c.id === target.channel);
    if (!channelEntry) {
      log.debug(`no channel entry for: ${target.channel}`);
      return;
    }
    const { allowFrom, cwd, model } = channelEntry;

    const execute = shouldExecute(allowFrom, message.fromUserId, message.chatType, message.isMentioned);
    if (!execute && channelEntry.sentryMode !== true) return;

    const content = message.text
      ? await expandLinks(message.text, this.config.linkExpand).catch(() => message.text!)
      : '';

    if (!execute) {
      this.observe(sessionKey, message, content, allowFrom);
      return;
    }

    adapter.startTyping(sessionKey);

    // If a run is already in flight for this chat, steer the new message into it: pi injects it
    // into the active session. Don't create a competing session/completion handler — a single
    // sessionKey has one session slot, and a second run racing cleanup is what dropped replies
    // (its agent.execute can settle early under steering while the real run continues).
    if (this.sessions.has(sessionKey)) {
      log.info(`← ${sessionKey} (steer) "${content.slice(0, 80)}"`);
      this.bus.call('agent.execute', { sessionKey, task: content, ...(cwd && { cwd }), ...(model && { model }) })
        .catch(err => log.error(`steered agent.execute failed: ${toMessage(err)}`));
      return;
    }

    const session: PipelineSession = {
      adapter,
      reactionController: this.startReaction(adapter, sessionKey, target.userId),
      replied: false,
    };
    this.sessions.set(sessionKey, session);

    log.info(`← ${sessionKey} "${content.slice(0, 80)}"`);

    // Cleanup is owned by onCompleted (pi's agent_end fires once at the true end of the run,
    // even under steering where a second message's agent.execute settles early). This catch
    // only covers a rejection that arrives WITHOUT a completion event (a pre-execution
    // failure), guarded by `completed` so it never double-sends or fights that cleanup.
    this.bus.call('agent.execute', {
      sessionKey,
      task: content,
      ...(cwd && { cwd }),
      ...(model && { model }),
    }).catch(err => {
      if (session.completed) return;
      const errorMsg = toMessage(err);
      log.error(`agent execution failed before completion: ${errorMsg}`);
      this.finalize(session, sessionKey, false);
      if (this.sessions.get(sessionKey) === session) this.sessions.delete(sessionKey);
      this.bus.call('channel.send', { sessionKey, text: `System error: ${errorMsg}` })
        .catch(sendErr => log.error(`failed to send error message: ${toMessage(sendErr)}`));
    });
  }

  /** Tool activity keeps the typing indicator alive; the reaction stays a stable 🤔. */
  onTool(payload: AgentToolPayload): void {
    const session = this.sessions.get(payload.sessionKey);
    if (!session) return;

    if (payload.sessionKey.includes(':subagent')) {
      log.debug('agent.onTool: subagent, skipping reaction');
      return;
    }

    log.debug(formatToolLog(payload));

    // One stable "working" reaction for the whole run (idempotent). Only the
    // typing indicator tracks per-tool activity.
    session.reactionController?.setWorking();
    if (payload.phase === 'start') {
      session.adapter.startTyping(payload.sessionKey); // resumes if the TTL paused it
    }
  }

  /** The one cleanup anchor for a run, and where a channel-triggered reply is delivered. */
  onCompleted(payload: AgentCompletedPayload): void {
    if (!payload.sessionKey || payload.sessionKey.includes(':subagent')) return;

    const session = this.sessions.get(payload.sessionKey);
    if (!session) {
      // Non-channel session (cron, webhook, etc.) — expected, ignore.
      log.debug(`onCompleted: session not found: ${payload.sessionKey}`);
      return;
    }

    // agent.onCompleted (pi's agent_end) fires once at the true end of the run — even with
    // steering, where a second message's agent.execute settles early. So THIS is the cleanup
    // anchor, not the execute promise: claim + remove the session now. The captured `session`
    // object still serves the async reply send + reaction seal below. `completed` guards the
    // process() catch against a double-send.
    session.completed = true;
    this.sessions.delete(payload.sessionKey);

    const sessionKey = payload.sessionKey;
    const text = payload.success ? (payload.response ?? '') : `Error: ${payload.error || 'Unknown error'}`;
    log.info(`→ ${sessionKey} ${payload.success ? '✓' : '✗'} (${text.length} chars)`);

    // Send on error (always), or on a successful response the agent didn't already deliver
    // via the channel-send tool.
    const shouldSend = !payload.success || (!session.replied && !!payload.response);
    const finalize = () => this.finalize(session, sessionKey, payload.success !== false);

    if (!shouldSend) { finalize(); return; }

    this.bus.call<{ sent: boolean }>('channel.send', { sessionKey, text })
      .then(({ sent }) => log.debug(`→ ${sessionKey} sent=${sent}`))
      .catch(err => log.error(`failed to send reply: ${toMessage(err)}`))
      .finally(finalize);
  }

  /**
   * Not executing. Still append to history so the agent has the context next time.
   * "Group, whitelisted, no @mention" is sentry mode and worth an info line; everything
   * else is simply not our business.
   */
  private observe(
    sessionKey: string,
    message: NormalizedInboundMessage,
    content: string,
    allowFrom: string[] | undefined,
  ): void {
    const observing = message.chatType === 'group'
      && !message.isMentioned
      && isAllowed(allowFrom, message.fromUserId);

    const line = `← ${sessionKey} (${observing ? 'observing (no @mention)' : 'not whitelisted'}) "${content.slice(0, 80)}"`;
    if (observing) log.info(line); else log.debug(line);

    this.bus.call('agent.appendMessage', { sessionKey, content })
      .catch(err => log.error(`failed to append message: ${toMessage(err)}`));
  }

  private startReaction(
    adapter: ChannelAdapter,
    sessionKey: string,
    chatId: string,
  ): StatusReactionController | undefined {
    const messageId = adapter.latestMessageId(chatId);
    if (!adapter.react || !messageId) return undefined;

    const controller = new StatusReactionController(
      { react: adapter.react.bind(adapter) },
      sessionKey,
      messageId,
    );
    controller.setWorking();
    return controller;
  }

  /** Seal the reaction (done/error) and stop the typing indicator. */
  private finalize(session: PipelineSession, sessionKey: string, success: boolean): void {
    if (session.reactionController) {
      if (success) session.reactionController.setDone();
      else session.reactionController.setError();
      session.reactionController.dispose();
    }
    session.adapter.stopTyping(sessionKey);
  }
}
