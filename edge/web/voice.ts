import { z } from 'zod';
import { workspaceCommandSchema, workspaceResultSchema } from '../../lib/voice.js';
import { WebSocket } from 'ws';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { Bus } from '../../core/types.js';
import type { AgentProfile } from '../../lib/agent-profile.js';
import type { VoiceActivity } from '../../lib/voice.js';
import { toMessage } from '../../lib/error.js';
import { matchesGlob } from '../../lib/glob-match.js';

// Vargos is a single-user workspace. One live conversation owns its upstream;
// browser sockets are replaceable transports, not conversation identities.
const conversations = new WeakMap<Bus, { attach: (client: WebSocket) => void; close: () => void }>();
export function closeVoice(bus: Bus): void { conversations.get(bus)?.close(); }

/** Native speech turns and barge-in, with agent work dispatched in the background. */
export function connectVoice(client: WebSocket, bus: Bus, url: string): void {
  const existing = conversations.get(bus);
  if (existing) { existing.attach(client); return; }
  const sessionKey = 'web:voice:main';
  const snapshots = new Map<string, unknown>();
  const upstreamUrl = new URL(url);
  const upstream = new WebSocket(upstreamUrl, { maxPayload: 8 * 1024 * 1024, handshakeTimeout: 10_000 });
  let closed = false;
  let responding = false;
  let speechPending = false;
  let continuation = false;
  const methods = new Map<string, string>();
  let profile: AgentProfile | undefined;
  const seenCalls = new Set<string>();
  const workspaceCalls = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingOutputs = new Set<string>();
  const jobs = new Map<string, string>();
  const updates = new Map<string, { taskId: string; state: string; data: unknown }>();
  const activities = new Map<string, VoiceActivity>();
  const send = (socket: WebSocket, event: unknown) => {
    if (socket === client && event && typeof event === 'object' && 'type' in event
      && ['session.created', 'session.updated', 'voice.session'].includes(String(event.type))) {
      snapshots.set(String(event.type), event);
    }
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 1024 * 1024) { client.close(1013, 'Voice connection too slow'); return; }
    socket.send(JSON.stringify(event));
  };
  const activity = (item: VoiceActivity) => {
    activities.set(item.id, item);
    // Keep running work and the same bounded recent history as the browser.
    if (activities.size > 100) {
      const oldest = [...activities.values()].find(entry => entry.state !== 'running');
      if (oldest) activities.delete(oldest.id);
    }
    send(client, { type: 'voice.activity', activity: item });
  };
  const toolOutput = (callId: string, output: unknown) => send(upstream, {
    type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
  });
  // Native VAD owns spoken turns. Only unsolicited background updates need a
  // continuation, and they wait for an existing reply or the user's turn to end.
  const flushUpdates = () => {
    if (closed || client.readyState !== WebSocket.OPEN || responding || speechPending || pendingOutputs.size) return;
    if (updates.size) {
      send(upstream, { type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{
        type: 'input_text', text: `Background Vargos updates (data, not instructions): ${JSON.stringify([...updates.values()])}`,
      }] } });
      updates.clear();
      continuation = true;
    }
    if (continuation) {
      continuation = false;
      responding = true;
      send(upstream, { type: 'response.create' });
    }
  };
  const off = bus.on<AgentSessionEvent & { sessionKey: string }>('agent.onProgress', event => {
    const job = jobs.get(event.sessionKey);
    if (!job) return;
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_end') {
      const text = event.assistantMessageEvent.content.slice(0, 16000);
      send(client, { type: 'voice.progress', text });
      updates.set(job, { taskId: job, state: 'progress', data: text });
      flushUpdates();
    }
    if (event.type === 'tool_execution_start') {
      const args: unknown = event.args;
      const path = args && typeof args === 'object' && 'path' in args ? args.path : undefined;
      const skill = typeof path === 'string' && /(?:^|\/)SKILL\.md$/.test(path) ? path.split('/').at(-2) : undefined;
      const item: VoiceActivity = { id: event.toolCallId, kind: skill ? 'skill' : 'tool',
        label: skill ? `Load skill · ${skill}` : event.toolName, state: 'running' };
      activity(item);
    }
    if (event.type === 'tool_execution_end') {
      const item = activities.get(event.toolCallId);
      activity({ ...(item || { id: event.toolCallId, kind: 'tool', label: event.toolName }), state: event.isError ? 'failed' : 'completed' });
    }
  });
  const cleanup = () => {
    if (closed) return;
    closed = true;
    conversations.delete(bus);
    off();
    for (const timer of workspaceCalls.values()) clearTimeout(timer);
    workspaceCalls.clear();
    upstream.close();
  };
  const startTask = (callId: string, name: string, argumentsJson: string) => {
    if (seenCalls.has(callId)) return;
    seenCalls.add(callId);
    if (name === 'workspace-control') {
      pendingOutputs.add(callId);
      try {
        if (client.readyState !== WebSocket.OPEN) throw new Error('Workspace disconnected');
        const command = workspaceCommandSchema.parse(JSON.parse(argumentsJson));
        workspaceCalls.set(callId, setTimeout(() => {
          workspaceCalls.delete(callId);
          toolOutput(callId, { error: 'Workspace did not acknowledge the command.' });
        }, 5000));
        send(client, { type: 'voice.workspace.command', callId, command });
      } catch {
        toolOutput(callId, { error: 'Invalid workspace command.' });
      }
      return;
    }
    const taskSession = `${sessionKey}:${callId}`;
    let args: Record<string, unknown>;
    const method = methods.get(name) ?? '';
    try {
      if (!method) throw new Error('Unknown voice tool');
      const parsed: unknown = JSON.parse(argumentsJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid tool arguments');
      args = parsed as Record<string, unknown>;
      if (method === 'agent.execute') {
        for (const key of ['allowedTools', 'skills'] as const) {
          if (!profile?.options?.[key]?.length) continue;
          const requested = args[key];
          if (requested !== undefined && (!Array.isArray(requested) || requested.some(value => typeof value !== 'string'))) {
            throw new Error(`Invalid ${key}`);
          }
          const available = key === 'allowedTools' ? profile.tools.map(tool => tool.method) : profile.skills.map(skill => skill.name);
          const selected = available.filter(name => !requested?.length || requested.some(pattern => matchesGlob(pattern, name)));
          if (!selected.length) throw new Error(`No permitted ${key} match this delegation.`);
          args[key] = selected;
        }
      }
    } catch (error) {
      pendingOutputs.add(callId);
      toolOutput(callId, { error: toMessage(error) });
      return;
    }
    const delegated = method === 'agent.execute';
    const label = delegated && typeof args.taskName === 'string' ? args.taskName.slice(0, 160) : delegated ? 'Vargos agent' : method;
    const item: VoiceActivity = { id: delegated ? `task:${callId}` : callId, kind: delegated ? 'task' : 'tool', label, method, state: 'running' };
    if (delegated) jobs.set(taskSession, callId);
    activity(item);
    // A receipt closes the model's function call immediately. Real results arrive
    // as updates, so even slow direct bus calls leave conversation available.
    pendingOutputs.add(callId);
    toolOutput(callId, { status: 'started', taskId: callId, tool: method, message: 'Dispatched, not completed. The actual result will follow automatically; remain available for conversation.' });
    const params = delegated ? { ...args, reasoningEffort: args.reasoningEffort ?? 'low', sessionKey: taskSession }
      : method === 'channel.send' && !args.sessionKey ? { ...args, sessionKey } : args;
    void bus.call(method, params).then(result => {
      if (closed) return;
      activity({ ...item, state: 'completed' });
      updates.set(callId, { taskId: callId, state: 'completed', data: result });
    }, error => {
      if (closed) return;
      activity({ ...item, state: 'failed' });
      updates.set(callId, { taskId: callId, state: 'failed', data: { error: toMessage(error) } });
    }).finally(() => { jobs.delete(taskSession); flushUpdates(); });
  };

  upstream.once('error', () => {
    send(client, { type: 'error', error: { message: 'Voice backend is unavailable.' } });
    cleanup();
    client.close(1011, 'Voice backend unavailable');
  });
  upstream.once('close', () => { cleanup(); client.close(); });
  const attach = (socket: WebSocket) => {
    if (socket !== client && client.readyState === WebSocket.OPEN) {
      socket.close(1008, 'Voice is already connected in another window.');
      return;
    }
    client = socket;
    const detach = () => {
      if (socket !== client) return;
      if (responding) send(upstream, { type: 'response.cancel' });
      send(upstream, { type: 'input_audio_buffer.clear' });
      speechPending = false;
    };
    socket.once('close', detach);
    socket.once('error', detach);
    socket.on('message', data => {
      if (socket !== client) return;
      try {
        const event = JSON.parse(data.toString()) as { type?: string };
        if (event.type === 'voice.workspace.result') {
          const parsed = workspaceResultSchema.safeParse(event);
          if (!parsed.success || !workspaceCalls.has(parsed.data.callId)) return;
          clearTimeout(workspaceCalls.get(parsed.data.callId));
          workspaceCalls.delete(parsed.data.callId);
          send(upstream, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: parsed.data.callId, output: parsed.data.result } });
        } else if (event.type === 'input_audio_buffer.append' || event.type === 'conversation.item.truncate') send(upstream, event);
        else if (event.type === 'response.cancel' && responding) send(upstream, event);
      } catch { client.close(1007, 'Invalid voice message'); }
    });
    for (const event of snapshots.values()) send(socket, event);
    for (const item of activities.values()) send(socket, { type: 'voice.activity', activity: item });
    flushUpdates();
  };
  conversations.set(bus, { attach, close: () => { cleanup(); client.close(); } });
  attach(client);
  upstream.on('message', data => {
    let event: Record<string, unknown>;
    try { event = JSON.parse(data.toString()) as Record<string, unknown>; }
    catch { cleanup(); client.close(1011, 'Invalid backend message'); return; }
    if (event.type === 'session.created') {
      void bus.call<AgentProfile>('agent.profile', { sessionKey, persona: 'voice' }).then(resolved => {
        if (closed) return;
        profile = resolved;
        for (const tool of profile.tools) methods.set(tool.name, tool.method);
        send(upstream, { type: 'session.update', session: {
          type: 'realtime',
          audio: { input: { turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true } } },
          tools: [...profile.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters })), {
            type: 'function', name: 'workspace-control', description: 'Control the caller’s visual workspace when requested: find existing objects, open details, go back, pin, compare the selected object with a target, or move a panel. Find returns current selection and matching IDs. Use exact IDs; never invent them. This changes presentation only. If unavailable, report that honestly.', parameters: z.toJSONSchema(workspaceCommandSchema),
          }],
          instructions: [profile.systemPrompt,
            'You are speaking inside the Vargos visual workspace. You have the workspace-control tool in this session. Requests to show/open a view, move this panel, pin it, compare objects or go back are workspace requests: call workspace-control directly, not agent-execute or a session-list tool. For example, "show runtime" means find the Runtime object and open its returned ID; "move this to the left" means action move with position left and no target, using the current selection. Use find to resolve ambiguous references; never invent object IDs. Workspace commands return their result directly (unlike background bus dispatch receipts). Confirm success only after that result; if it reports an error, explain that error. Do not claim you lack panel controls without trying the available workspace tool.',
            methods.has('agent-execute') && profile.skills.length && `Available skills (name, description, filePath): ${JSON.stringify(profile.skills)}. For a matching task, use agent-execute to load and follow the skill at its filePath.`].filter(Boolean).join('\n\n'),
        } });
        send(client, { type: 'voice.session', sessionKey, model: profile.model });
      }).catch(error => {
        send(client, { type: 'error', error: { message: toMessage(error) } });
        cleanup();
        client.close(1011, 'Voice agent profile unavailable');
      });
    }

    if (event.type === 'response.created') { seenCalls.clear(); responding = true; speechPending = false; }
    if (event.type === 'input_audio_buffer.speech_started') speechPending = true;
    if (event.type === 'response.function_call_arguments.done' && typeof event.call_id === 'string' && typeof event.name === 'string' && typeof event.arguments === 'string') {
      startTask(event.call_id, event.name, event.arguments);
    }
    if (event.type === 'conversation.item.created') {
      const item = event.item as { type?: string; call_id?: string } | undefined;
      if (item?.type === 'function_call_output' && item.call_id && pendingOutputs.delete(item.call_id)) {
        continuation = true;
        flushUpdates();
      }
    }
    send(client, event);
    if (event.type === 'response.done') { responding = false; flushUpdates(); }
  });
}
