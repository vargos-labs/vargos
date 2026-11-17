import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { EmitterBus } from '../../../core/bus.js';
import { connectVoice, closeVoice } from '../voice.js';
import type { AgentProfile } from '../../../lib/agent-profile.js';
import { matchesGlob } from '../../../lib/glob-match.js';

const servers: WebSocketServer[] = [];
const clients: WebSocket[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  await Promise.all(servers.splice(0).map(server => {
    for (const client of server.clients) client.terminate();
    return new Promise<void>(resolve => server.close(() => resolve()));
  }));
});

async function setup(handler = vi.fn(async (_params: unknown): Promise<unknown> => ({ response: 'Done' })), autoAcknowledge = true, configure?: (bus: EmitterBus) => void, options?: AgentProfile['options']) {
  const bus = new EmitterBus();
  bus.register('agent.execute', { description: 'Execute a task', schema: z.object({ task: z.string() }).passthrough() }, handler);
  configure?.(bus);
  bus.register('agent.profile', { description: 'Profile fixture', internal: true, schema: z.object({ sessionKey: z.string(), persona: z.string() }) }, () => ({
    systemPrompt: 'Voice test persona',
    options,
    skills: [{ name: 'research', description: 'Research a topic', filePath: '/skills/research/SKILL.md' }],
    tools: bus.list().filter(method => !method.internal && (!options?.allowedTools?.length || options.allowedTools.some(pattern => matchesGlob(pattern, method.name)))).map(method => ({ name: method.name.replace(/\./g, '-'), method: method.name, description: method.description, parameters: method.schema })),
  }));
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const browser = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(upstream, browser);
  await Promise.all([once(upstream, 'listening'), once(browser, 'listening')]);
  const received: Record<string, unknown>[] = [];
  let backend!: WebSocket;
  upstream.on('connection', socket => {
    backend = socket;
    socket.on('message', data => {
      const event = JSON.parse(data.toString());
      received.push(event);
      if (autoAcknowledge && event.type === 'conversation.item.create') socket.send(JSON.stringify({ type: 'conversation.item.created', item: event.item }));
    });
    socket.send(JSON.stringify({ type: 'session.created', session: {} }));
  });
  browser.on('connection', socket => connectVoice(socket, bus, `ws://127.0.0.1:${(upstream.address() as AddressInfo).port}`));
  const client = new WebSocket(`ws://127.0.0.1:${(browser.address() as AddressInfo).port}`);
  clients.push(client);
  const events: Record<string, unknown>[] = [];
  client.on('message', data => events.push(JSON.parse(data.toString())));
  await vi.waitFor(() => expect(received.some(e => e.type === 'session.update')).toBe(true));
  return { bus, client, backend, received, events, handler, browser };
}
function dispatch(backend: WebSocket, id = 'one') {
  backend.send(JSON.stringify({ type: 'response.created' }));
  backend.send(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: id, name: 'agent-execute', arguments: '{"task":"Check status","sessionKey":"spoofed"}' }));
  backend.send(JSON.stringify({ type: 'response.done' }));
}
function outputEvents(received: Record<string, unknown>[]) {
  return received.filter(e => e.type === 'conversation.item.create').map(e => e.item as { type: string; output?: string; content?: { text: string }[] });
}

describe('native voice bridge', () => {
  it('retries profile loading after a failed initialization', async () => {
    const { client, browser, received, bus } = await setup();
    const closed = once(client, 'close');
    closeVoice(bus);
    await closed;
    const call = vi.spyOn(bus, 'call').mockRejectedValueOnce(new Error('Profile unavailable'));
    const failed = new WebSocket(`ws://127.0.0.1:${(browser.address() as AddressInfo).port}`);
    clients.push(failed);
    await once(failed, 'close');
    call.mockRestore();
    const replacement = new WebSocket(`ws://127.0.0.1:${(browser.address() as AddressInfo).port}`);
    clients.push(replacement);
    await vi.waitFor(() => expect(received.filter(event => event.type === 'session.update')).toHaveLength(2));
  });

  it('recreates the upstream after malformed backend messages', async () => {
    const { client, backend, browser, received } = await setup();
    const closed = once(client, 'close');
    backend.send('invalid-json');
    await closed;
    const replacement = new WebSocket(`ws://127.0.0.1:${(browser.address() as AddressInfo).port}`);
    clients.push(replacement);
    await vi.waitFor(() => expect(received.filter(event => event.type === 'session.update')).toHaveLength(2));
  });

  it('replays running and detached completion activities on reconnect', async () => {
    let finish!: (value: unknown) => void;
    const { client, backend, browser, handler } = await setup(vi.fn(() => new Promise(resolve => { finish = resolve; })));
    dispatch(backend);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    client.close();
    await once(client, 'close');
    const reconnect = () => {
      const socket = new WebSocket(`ws://127.0.0.1:${(browser.address() as AddressInfo).port}`);
      clients.push(socket);
      const events: Record<string, unknown>[] = [];
      socket.on('message', data => events.push(JSON.parse(data.toString())));
      return { socket, events };
    };
    const first = reconnect();
    await vi.waitFor(() => expect(first.events).toContainEqual(expect.objectContaining({ type: 'voice.activity', activity: expect.objectContaining({ id: 'task:one', state: 'running' }) })));
    first.socket.close();
    await once(first.socket, 'close');
    finish({ response: 'Done' });
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = reconnect();
    await vi.waitFor(() => expect(second.events).toContainEqual(expect.objectContaining({ type: 'voice.activity', activity: expect.objectContaining({ id: 'task:one', state: 'completed' }) })));
  });

  it('reattaches to the same upstream conversation and closes it on service disposal', async () => {
    const { client, backend, browser, received, bus } = await setup();
    backend.send(JSON.stringify({ type: 'session.updated', session: {} }));
    await new Promise(resolve => setTimeout(resolve, 20));
    client.close();
    await once(client, 'close');
    await vi.waitFor(() => expect(received.some(event => event.type === 'input_audio_buffer.clear')).toBe(true));
    expect(backend.readyState).toBe(WebSocket.OPEN);
    const replacement = new WebSocket(`ws://127.0.0.1:${(browser.address() as AddressInfo).port}`);
    clients.push(replacement);
    const events: Record<string, unknown>[] = [];
    replacement.on('message', data => events.push(JSON.parse(data.toString())));
    await vi.waitFor(() => expect(events.some(event => event.type === 'session.updated')).toBe(true));
    expect(events.find(event => event.type === 'voice.session')?.sessionKey).toBe('web:voice:main');
    expect(received.filter(event => event.type === 'session.update')).toHaveLength(1);
    const disconnected = once(backend, 'close');
    closeVoice(bus);
    await disconnected;
  });

  it('holds background results while detached and delivers them on reconnect', async () => {
    let finish!: (value: unknown) => void;
    const handler = vi.fn(() => new Promise<unknown>(resolve => { finish = resolve; }));
    const { client, backend, browser, received } = await setup(handler);
    backend.send(JSON.stringify({ type: 'session.updated', session: {} }));
    dispatch(backend);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    client.close();
    await once(client, 'close');
    await vi.waitFor(() => expect(received.some(event => event.type === 'input_audio_buffer.clear')).toBe(true));
    backend.send(JSON.stringify({ type: 'response.done' }));
    finish({ response: 'Finished while disconnected' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(JSON.stringify(received)).not.toContain('Finished while disconnected');
    const replacement = new WebSocket(`ws://127.0.0.1:${(browser.address() as AddressInfo).port}`);
    clients.push(replacement);
    await vi.waitFor(() => expect(JSON.stringify(received)).toContain('Finished while disconnected'));
  });

  it('rejects a second browser without replacing the active conversation', async () => {
    const { browser, client, backend } = await setup();
    const second = new WebSocket(`ws://127.0.0.1:${(browser.address() as AddressInfo).port}`);
    clients.push(second);
    const [code] = await once(second, 'close');
    expect(code).toBe(1008);
    expect(client.readyState).toBe(WebSocket.OPEN);
    expect(backend.readyState).toBe(WebSocket.OPEN);
  });

  it('routes workspace commands to the calling browser and waits for its acknowledgement', async () => {
    const { backend, client, events, received, handler } = await setup();
    backend.send(JSON.stringify({ type: 'response.created' }));
    backend.send(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'workspace-one', name: 'workspace-control', arguments: JSON.stringify({ action: 'open', target: 'runtime' }) }));
    backend.send(JSON.stringify({ type: 'response.done' }));
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'voice.workspace.command', callId: 'workspace-one', command: { action: 'open', target: 'runtime' } }));
    expect(received.some(event => event.type === 'response.create')).toBe(false);
    client.send(JSON.stringify({ type: 'voice.workspace.result', callId: 'unrelated', result: '{"status":"applied"}' }));
    client.send(JSON.stringify({ type: 'voice.workspace.result', callId: 'workspace-one', result: '{"status":"applied"}' }));
    await vi.waitFor(() => expect(received.some(event => event.type === 'response.create')).toBe(true));
    expect(outputEvents(received).filter(event => event.type === 'function_call_output')).toEqual([{ type: 'function_call_output', call_id: 'workspace-one', output: '{"status":"applied"}' }]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects workspace actions outside the presentation command schema', async () => {
    const { backend, events, received, handler } = await setup();
    backend.send(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'bad-workspace', name: 'workspace-control', arguments: '{"action":"restart"}' }));
    await vi.waitFor(() => expect(outputEvents(received).some(event => event.output?.includes('Invalid workspace command'))).toBe(true));
    expect(events.some(event => event.type === 'voice.workspace.command')).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('uses native VAD and barge-in, passes audio and truncation through, and keeps tool definitions server-owned', async () => {
    const { client, received } = await setup();
    expect(JSON.stringify(received[0])).toContain('/skills/research/SKILL.md');
    expect(JSON.stringify(received[0])).toContain('call workspace-control directly');
    expect(JSON.stringify(received[0])).toContain('Workspace commands return their result directly');
    expect(received[0]).toMatchObject({ session: { audio: { input: { turn_detection: { create_response: true, interrupt_response: true } } }, tools: [{ name: 'agent-execute' }, { name: 'workspace-control' }] } });
    client.send(JSON.stringify({ type: 'session.update', session: { tools: [{ name: 'untrusted' }] } }));
    client.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: 'AAAA' }));
    client.send(JSON.stringify({ type: 'conversation.item.truncate', item_id: 'reply', content_index: 0, audio_end_ms: 400 }));
    await vi.waitFor(() => expect(received).toContainEqual({ type: 'conversation.item.truncate', item_id: 'reply', content_index: 0, audio_end_ms: 400 }));
    expect(received).toContainEqual({ type: 'input_audio_buffer.append', audio: 'AAAA' });
    expect(received.filter(e => e.type === 'session.update')).toHaveLength(1);
  });

  it('acknowledges dispatch immediately and keeps microphone audio flowing while the task runs', async () => {
    let finish!: (result: unknown) => void;
    const handler = vi.fn((_params: unknown) => new Promise<unknown>(resolve => { finish = resolve; }));
    const { backend, client, received } = await setup(handler);
    dispatch(backend);
    await vi.waitFor(() => expect(received).toContainEqual({ type: 'response.create' }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ sessionKey: expect.stringMatching(/^web:voice:.*:one$/), reasoningEffort: 'low' });
    const output = outputEvents(received).find(e => e.type === 'function_call_output');
    expect(JSON.parse(output!.output!)).toMatchObject({ status: 'started', taskId: 'one' });
    client.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: 'WHILE_RUNNING' }));
    await vi.waitFor(() => expect(received).toContainEqual({ type: 'input_audio_buffer.append', audio: 'WHILE_RUNNING' }));
    finish({ response: 'Finished' });
  });

  it('limits delegated tools and skills to the voice persona even when wildcard overrides are requested', async () => {
    const { backend, handler } = await setup(undefined, true, bus => {
      bus.register('memory.search', { description: 'Search', schema: z.object({}) }, () => []);
      bus.register('memory.delete', { description: 'Delete', schema: z.object({}) }, () => []);
    }, { allowedTools: ['agent.execute', 'memory.search'], skills: ['research'] });
    backend.send(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'restricted', name: 'agent-execute', arguments: JSON.stringify({ task: 'Investigate', allowedTools: ['*'], skills: ['*'] }) }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(handler.mock.calls[0][0]).toMatchObject({ allowedTools: ['agent.execute', 'memory.search'], skills: ['research'] });
  });

  it('rejects disjoint delegation restrictions instead of restoring unrestricted defaults', async () => {
    const { backend, handler, received } = await setup(undefined, true, undefined,
      { allowedTools: ['agent.execute'], skills: ['research'] });
    for (const [key, selection] of [['allowedTools', 'memory.delete'], ['skills', 'unavailable']]) {
      backend.send(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: key, name: 'agent-execute', arguments: JSON.stringify({ task: 'Investigate', [key]: [selection] }) }));
    }
    await vi.waitFor(() => expect(outputEvents(received).filter(item => item.output?.includes('No permitted'))).toHaveLength(2));
    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves an explicit reasoning effort for voice-dispatched agents', async () => {
    const { backend, handler } = await setup();
    backend.send(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'explicit', name: 'agent-execute', arguments: JSON.stringify({ task: 'Investigate', reasoningEffort: 'high' }) }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler.mock.calls[0][0]).toMatchObject({ reasoningEffort: 'high' });
  });

  it('returns completion and failures as background updates without pretending the dispatch was the final answer', async () => {
    const { backend, received } = await setup();
    dispatch(backend);
    await vi.waitFor(() => expect(outputEvents(received).some(e => e.type === 'message' && JSON.stringify(e).includes('completed'))).toBe(true));
    expect(JSON.parse(outputEvents(received).find(e => e.type === 'function_call_output')!.output!)).toHaveProperty('status', 'started');
    expect(JSON.stringify(outputEvents(received).filter(e => e.type === 'message'))).toContain('Done');
    const failed = await setup(vi.fn(async (_params: unknown) => { throw new Error('Inference unavailable'); }));
    dispatch(failed.backend);
    await vi.waitFor(() => expect(JSON.stringify(outputEvents(failed.received))).toContain('Inference unavailable'));
    expect(JSON.stringify(outputEvents(failed.received))).toContain('failed');
  });

  it('coalesces progress while the user is speaking and gives the model updates once the spoken turn finishes', async () => {
    let finish!: (result: unknown) => void;
    const handler = vi.fn((_params: unknown) => new Promise<unknown>(resolve => { finish = resolve; }));
    const { bus, backend, received, events } = await setup(handler);
    dispatch(backend);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    const { sessionKey } = handler.mock.calls[0][0] as { sessionKey: string };
    backend.send(JSON.stringify({ type: 'response.done' }));
    backend.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    await vi.waitFor(() => expect(events.some(e => e.type === 'input_audio_buffer.speech_started')).toBe(true));
    bus.emit('agent.onProgress', { sessionKey: 'other', type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'Hidden' } });
    for (const content of ['First finding', 'Useful update']) bus.emit('agent.onProgress', { sessionKey, type: 'message_update', assistantMessageEvent: { type: 'text_end', content } });
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'voice.progress', text: 'Useful update' }));
    expect(outputEvents(received).filter(e => e.type === 'message')).toHaveLength(0);
    backend.send(JSON.stringify({ type: 'response.created' }));
    backend.send(JSON.stringify({ type: 'response.done' }));
    await vi.waitFor(() => expect(JSON.stringify(outputEvents(received))).toContain('Useful update'));
    expect(JSON.stringify(outputEvents(received))).not.toContain('First finding');
    expect(JSON.stringify(outputEvents(received))).not.toContain('Hidden');
    finish({ response: 'Done' });
  });

  it('reports actual skill loading and tool completion without exposing arguments', async () => {
    let finish!: (result: unknown) => void;
    const handler = vi.fn((_params: unknown) => new Promise<unknown>(resolve => { finish = resolve; }));
    const { bus, backend, events } = await setup(handler);
    dispatch(backend);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    const { sessionKey } = handler.mock.calls[0][0] as { sessionKey: string };
    bus.emit('agent.onProgress', { sessionKey, type: 'tool_execution_start', toolCallId: 'skill', toolName: 'read', args: { path: '/private/skills/research/SKILL.md', secret: 'hidden' } });
    bus.emit('agent.onProgress', { sessionKey, type: 'tool_execution_end', toolCallId: 'skill', toolName: 'read', isError: false });
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'voice.activity', activity: { id: 'skill', kind: 'skill', label: 'Load skill · research', state: 'completed' } }));
    expect(JSON.stringify(events.filter(e => e.type === 'voice.activity'))).not.toContain('hidden');
    expect(JSON.stringify(events.filter(e => e.type === 'voice.activity'))).not.toContain('/private/');
    finish({ response: 'Done' });
  });

  it('deduplicates tool calls and waits for all immediate output acknowledgements before continuation', async () => {
    const { backend, received, handler } = await setup(undefined, false);
    backend.send(JSON.stringify({ type: 'response.created' }));
    for (const id of ['first', 'first', 'second']) backend.send(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: id, name: 'agent-execute', arguments: '{"task":"Check"}' }));
    backend.send(JSON.stringify({ type: 'response.done' }));
    await vi.waitFor(() => expect(outputEvents(received).filter(e => e.type === 'function_call_output')).toHaveLength(2));
    expect(received.some(e => e.type === 'response.create')).toBe(false);
    backend.send(JSON.stringify({ type: 'conversation.item.created', item: { type: 'function_call_output', call_id: 'first' } }));
    expect(received.some(e => e.type === 'response.create')).toBe(false);
    backend.send(JSON.stringify({ type: 'conversation.item.created', item: { type: 'function_call_output', call_id: 'second' } }));
    await vi.waitFor(() => expect(received.filter(e => e.type === 'response.create')).toHaveLength(1));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('calls memory directly with its canonical schema and returns the actual result', async () => {
    const search = vi.fn(async (_params: unknown) => ({ matches: ['Saved context'] }));
    const { backend, received, handler, events } = await setup(undefined, true, bus => {
      bus.register('memory.search', { description: 'Search memory', schema: z.object({ query: z.string() }) }, search);
      bus.register('memory.read', { description: 'Read memory', schema: z.object({ path: z.string() }) }, async () => 'Memory text');
      bus.register('mcp.local.inspect', { description: 'Internal agent tool', external: false, schema: z.object({}) }, async () => 'Available');
      bus.register('private.secret', { description: 'Hidden', internal: true, schema: z.object({}) }, async () => 'Hidden');
    });
    const update = received[0] as { session: { tools: { name: string; parameters: unknown }[]; instructions: string } };
    expect(update.session.instructions).toContain('Voice test persona');
    expect(update.session.instructions).toContain('use agent-execute to load and follow');
    expect(update.session.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['agent-execute', 'memory-search', 'memory-read', 'mcp-local-inspect']));
    expect(update.session.tools.map(tool => tool.name)).not.toContain('private-secret');
    expect(update.session.tools.find(tool => tool.name === 'memory-search')?.parameters).toMatchObject({ properties: { query: { type: 'string' } } });
    backend.send(JSON.stringify({ type: 'response.created' }));
    backend.send(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'memory', name: 'memory-search', arguments: '{"query":"voice setup"}' }));
    backend.send(JSON.stringify({ type: 'response.done' }));
    await vi.waitFor(() => expect(search).toHaveBeenCalledWith({ query: 'voice setup' }));
    await vi.waitFor(() => expect(JSON.stringify(outputEvents(received).filter(item => item.type === 'message'))).toContain('Saved context'));
    expect(JSON.parse(outputEvents(received).find(item => item.type === 'function_call_output')!.output!)).toMatchObject({ status: 'started', tool: 'memory.search' });
    expect(handler).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'voice.activity', activity: { id: 'memory', kind: 'tool', label: 'memory.search', method: 'memory.search', state: 'completed' } }));
  });

  it('returns direct-tool validation errors without delegating or disconnecting', async () => {
    const { backend, received, handler } = await setup(undefined, true, bus => {
      bus.register('memory.search', { description: 'Search memory', schema: z.object({ query: z.string() }) }, async () => 'Result');
    });
    backend.send(JSON.stringify({ type: 'response.created' }));
    backend.send(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'invalid', name: 'memory-search', arguments: '{}' }));
    backend.send(JSON.stringify({ type: 'response.done' }));
    await vi.waitFor(() => expect(outputEvents(received).filter(item => item.type === 'function_call_output')).toHaveLength(1));
    await vi.waitFor(() => expect(JSON.stringify(outputEvents(received).filter(item => item.type === 'message'))).toContain('failed'));
    expect(JSON.parse(outputEvents(received).find(item => item.type === 'function_call_output')!.output!)).toHaveProperty('status', 'started');
    expect(handler).not.toHaveBeenCalled();
  });


  it('closes a slow direct call before its result and remains conversational without starting an agent', async () => {
    let finish!: (result: unknown) => void;
    const search = vi.fn((_params: unknown) => new Promise<unknown>(resolve => { finish = resolve; }));
    const { backend, client, received, handler } = await setup(undefined, true, bus => {
      bus.register('memory.search', { description: 'Search memory', schema: z.object({ query: z.string() }) }, search);
    });
    backend.send(JSON.stringify({ type: 'response.created' }));
    backend.send(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'slow-memory', name: 'memory-search', arguments: '{"query":"voice"}' }));
    backend.send(JSON.stringify({ type: 'response.done' }));
    await vi.waitFor(() => expect(received).toContainEqual({ type: 'response.create' }));
    expect(JSON.parse(outputEvents(received).find(item => item.type === 'function_call_output')!.output!)).toMatchObject({ status: 'started', tool: 'memory.search' });
    client.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: 'DURING_SEARCH' }));
    await vi.waitFor(() => expect(received).toContainEqual({ type: 'input_audio_buffer.append', audio: 'DURING_SEARCH' }));
    expect(handler).not.toHaveBeenCalled();
    finish({ matches: ['Actual memory result'] });
    backend.send(JSON.stringify({ type: 'response.done' }));
    await vi.waitFor(() => expect(JSON.stringify(outputEvents(received))).toContain('Actual memory result'));
    expect(outputEvents(received).filter(item => item.type === 'function_call_output')).toHaveLength(1);
    expect(search).toHaveBeenCalledTimes(1);
  });

});
