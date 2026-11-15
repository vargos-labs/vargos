import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Progress } from '@modelcontextprotocol/sdk/types.js';
import { EmitterBus } from '../../../core/bus.js';
import { z } from 'zod';
import { McpEdge } from '../index.js';

const PORT = 9138;
const bus = new EmitterBus();
let releaseExecution: (() => void) | undefined;
let heldExecution = Promise.resolve();
let finishHeldExecution: (() => void) | undefined;
const sessions: string[] = [];
let activeSubscriptions = 0;
const originalOn = bus.on.bind(bus);
bus.on = (name, listener) => {
  activeSubscriptions++;
  const off = originalOn(name, listener);
  let stopped = false;
  return () => { if (!stopped) { stopped = true; activeSubscriptions--; off(); } };
};
bus.register('config.get', { schema: z.object({}), description: 'Config', internal: true }, () => (
  { mcp: { host: '127.0.0.1', port: PORT, bearerToken: 'test' } }
));
bus.register('agent.execute', {
  schema: z.object({ task: z.string(), sessionKey: z.string() }), description: 'Execute',
}, async (args) => {
  sessions.push(args.sessionKey);
  bus.emit('agent.onProgress', { sessionKey: 'unrelated', type: 'tool_execution_start', toolName: 'private' });
  bus.emit('agent.onProgress', { sessionKey: args.sessionKey, type: 'tool_execution_start', toolCallId: '1', toolName: args.task, args: { secret: 'private' } });
  if (args.task === 'hold') {
    heldExecution = new Promise<void>(resolve => { finishHeldExecution = resolve; });
    await new Promise<void>(resolve => { releaseExecution = resolve; });
  }
  await new Promise(resolve => setTimeout(resolve, 30));
  bus.emit('agent.onProgress', { sessionKey: args.sessionKey, type: 'tool_execution_end', toolCallId: '1', toolName: args.task, isError: false, result: { secret: 'private' } });
  bus.emit('agent.onProgress', {
    sessionKey: args.sessionKey, type: 'message_update',
    assistantMessageEvent: { type: 'thinking_end', content: 'private reasoning' },
  });
  bus.emit('agent.onProgress', {
    sessionKey: args.sessionKey, type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'unfinished' },
  });
  bus.emit('agent.onProgress', {
    sessionKey: args.sessionKey, type: 'message_update', message: { secret: 'private' },
    assistantMessageEvent: { type: 'text_end', content: `Checked ${args.task}`, partial: { secret: 'private' } },
  });
  if (args.task === 'fail') throw new Error('execution failed');
  if (args.task === 'hold') finishHeldExecution?.();
  return { response: args.task };
});

describe('session-scoped agent MCP progress', () => {
  let edge: McpEdge;
  let client: Client;
  let oldPort: string | undefined;
  beforeAll(async () => {
    oldPort = process.env.MCP_PORT;
    process.env.MCP_PORT = String(PORT);
    edge = new McpEdge();
    await edge.init(bus);
    client = new Client({ name: 'progress-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer test' } },
    }));
  });
  afterAll(async () => {
    await client.close();
    await edge.dispose();
    if (oldPort === undefined) delete process.env.MCP_PORT;
    else process.env.MCP_PORT = oldPort;
  });

  it('isolates concurrent calls and delivers progress before the unchanged final result', async () => {
    const a: Progress[] = [];
    const b: Progress[] = [];
    const [ra, rb] = await Promise.all([
      client.callTool({ name: 'agent.execute', arguments: { task: 'search', sessionKey: 'caller-supplied' } }, undefined, {
        onprogress: update => { a.push(update); },
      }),
      client.callTool({ name: 'agent.execute', arguments: { task: 'read', sessionKey: 'another-session' } }, undefined, {
        onprogress: update => { b.push(update); },
      }),
    ]);
    expect(a.map(p => JSON.parse(p.message!).type)).toEqual(['tool_execution_start', 'tool_execution_end', 'message_update']);
    expect(a.map(p => p.progress)).toEqual([1, 2, 3]);
    expect(JSON.parse(a[2].message!)).toEqual({ sessionKey: 'caller-supplied', type: 'message_update',
      assistantMessageEvent: { type: 'text_end', content: 'Checked search' } });
    expect(JSON.stringify(a)).not.toMatch(/private|thinking_end|text_delta|unfinished/);
    expect(b.map(p => JSON.parse(p.message!).sessionKey)).toEqual(Array(3).fill('another-session'));
    expect(a[0].progress).toBe(1);
    expect(ra.content).toEqual([{ type: 'text', text: JSON.stringify({ response: 'search' }) }]);
    expect(rb.isError).toBe(false);
    expect(sessions.slice(0, 2)).toEqual(['caller-supplied', 'another-session']);
    expect(activeSubscriptions).toBe(0);
  });

  it('uses the MCP agent session and skips progress listeners unless requested', async () => {
    const result = await client.callTool({ name: 'agent.execute', arguments: { task: 'quiet', taskName: 'Daily Research!' } });
    expect(result.isError).toBe(false);
    expect(sessions.at(-1)).toBe('mcp:agent:daily-research');
    expect(activeSubscriptions).toBe(0);
  });

  it('uses a timestamp for an unnamed conversation', async () => {
    const before = Date.now();
    await client.callTool({ name: 'agent.execute', arguments: { task: 'Check Recent Sources!' } });
    const key = sessions.at(-1)!;
    expect(key).toMatch(/^mcp:agent:\d+$/);
    const timestamp = Number(key.split(':').at(-1));
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(Date.now());
  });

  it('unsubscribes on disconnect while execution continues', async () => {
    const disconnecting = new Client({ name: 'disconnect-test', version: '1' });
    await disconnecting.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer test' } },
    }));
    let received!: () => void;
    const firstUpdate = new Promise<void>(resolve => { received = resolve; });
    const call = disconnecting.callTool({ name: 'agent.execute', arguments: { task: 'hold' } }, undefined, {
      onprogress: () => { received(); },
    }).catch(() => undefined);
    try {
      await firstUpdate;
      expect(activeSubscriptions).toBe(1);
      await disconnecting.close();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(activeSubscriptions).toBe(0);
    } finally {
      releaseExecution?.();
      await heldExecution;
      await call;
      await disconnecting.close();
    }
  });

  it('cleans up progress subscriptions on execution failure', async () => {
    const updates: Progress[] = [];
    const result = await client.callTool({ name: 'agent.execute', arguments: { task: 'fail' } }, undefined, {
      onprogress: update => { updates.push(update); },
    });
    expect(updates.map(p => JSON.parse(p.message!).type)).toEqual(['tool_execution_start', 'tool_execution_end', 'message_update']);
    expect(result.isError).toBe(true);
    expect(activeSubscriptions).toBe(0);
    expect(JSON.stringify(updates)).not.toContain('private');
  });
});
