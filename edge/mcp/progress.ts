import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ProgressNotification, ProgressToken } from '@modelcontextprotocol/sdk/types.js';
import type { Bus } from '../../core/types.js';

/** Select outward text and tool activity, never reasoning, arguments, or raw results. */
function outwardEvent(event: AgentSessionEvent & { sessionKey: string }): unknown {
  const { sessionKey, type } = event;
  if (type === 'message_update' && event.assistantMessageEvent.type === 'text_end') {
    const { content } = event.assistantMessageEvent;
    return { sessionKey, type, assistantMessageEvent: { type: 'text_end', content: content.slice(0, 16000) } };
  }
  if (type === 'tool_execution_start' || type === 'tool_execution_end') {
    return { sessionKey, type, toolCallId: event.toolCallId, toolName: event.toolName,
      ...(type === 'tool_execution_end' && { isError: event.isError }) };
  }
}

/** Forward approved events from this session onto the requesting MCP stream. */
export function subscribeProgress(
  bus: Bus,
  sessionKey: string | undefined,
  progressToken: ProgressToken | undefined,
  signal: AbortSignal,
  send: (notification: ProgressNotification) => Promise<void>,
): () => Promise<void> {
  if (!sessionKey || undefined === progressToken || signal.aborted) return async () => {};
  let pending = Promise.resolve();
  let queued = 0;
  let progress = 0;
  let closed = false;
  const unsubscribe = bus.on<AgentSessionEvent & { sessionKey: string }>('agent.onProgress', event => {
    if (closed || signal.aborted || event.sessionKey !== sessionKey || queued >= 32) return;
    const outward = outwardEvent(event);
    if (!outward) return;
    const message = JSON.stringify(outward);
    const sequence = ++progress;
    queued++;
    pending = pending.then(async () => {
      if (closed || signal.aborted) return;
      await send({ method: 'notifications/progress', params: { progressToken, progress: sequence, message } });
    }).catch(() => { stop(); }).finally(() => { queued--; });
  });
  const stop = () => {
    closed = true;
    unsubscribe();
  };
  signal.addEventListener('abort', stop, { once: true });
  return async () => {
    unsubscribe();
    await pending;
    closed = true;
    signal.removeEventListener('abort', stop);
  };
}
