import http from 'node:http';
import { once } from 'node:events';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpEdge } from '../index.js';
import type { Bus } from '../../../core/types.js';

const PORT = 9137;
const TOKEN = 'test-bearer-token';
const ENDPOINT = `http://127.0.0.1:${PORT}/mcp`;

/** Minimal bus: config.get for the edge, one visible tool plus one internal tool. */
function stubBus(): Bus {
  const tools = [
    { name: 'echo', description: 'Echo back', schema: { type: 'object', properties: { msg: { type: 'string' } } }, internal: false },
    { name: 'internal.only', description: 'hidden', schema: {}, internal: true },
  ];
  return {
    list: () => tools,
    has: (name: string) => tools.some(t => t.name === name),
    call: async (method: string, params: unknown) =>
      method === 'config.get'
        ? { mcp: { host: '127.0.0.1', port: PORT, bearerToken: TOKEN } }
        : { echo: (params as { msg?: string })?.msg ?? 'ok' },
    emit: () => {},
    on: () => () => {},
    register: () => () => {},
    unregister: () => false,
  } as unknown as Bus;
}

function post(body: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body) });
}

/** SDK answers either as a JSON body or as an SSE stream — accept both shapes. */
async function jsonFrom(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    const line = text.split('\n').find(l => l.startsWith('data: '));
    if (!line) throw new Error(`no SSE data in: ${text}`);
    return JSON.parse(line.slice(6)) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

const initialize = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: `client-${id}`, version: '1' },
  },
});

describe('edge-mcp HTTP connection handling', () => {
  let edge: McpEdge;

  beforeAll(async () => {
    // The daemon exports MCP_PORT; pin it so the edge binds the test port, not 9001.
    process.env.MCP_PORT = String(PORT);
    edge = new McpEdge();
    await edge.init(stubBus());
  });

  afterAll(async () => {
    await edge.dispose();
    delete process.env.MCP_PORT;
  });

  it('lets two clients initialize independently', async () => {
    const [a, b] = await Promise.all([post(initialize(1)), post(initialize(2))]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const ra = await jsonFrom(a);
    const rb = await jsonFrom(b);
    expect((ra.result as { serverInfo: { name: string } }).serverInfo.name).toBe('vargos');
    expect((rb.result as { serverInfo: { name: string } }).serverInfo.name).toBe('vargos');
    expect(ra.error).toBeUndefined();
    expect(rb.error).toBeUndefined();
  });

  it('repeating initialize for the same client does not fail', async () => {
    const first = await post(initialize(1));
    expect(first.status).toBe(200);
    await first.text();

    const again = await post(initialize(1));
    expect(again.status).toBe(200);
    expect((await jsonFrom(again)).error).toBeUndefined();
  });

  it('is stateless: no Mcp-Session-Id issued or required', async () => {
    const init = await post(initialize(1));
    expect(init.headers.get('mcp-session-id')).toBeNull();
    await init.text();

    // tools/list with no session header at all
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(list.status).toBe(200);
    const tools = (await jsonFrom(list)).result as { tools: { name: string }[] };
    expect(tools.tools.map(t => t.name)).toEqual(['echo']);

    // a stale session header is ignored, not rejected
    const stale = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TOKEN}`,
        'Mcp-Session-Id': 'does-not-exist',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    expect(stale.status).toBe(200);
  });

  it('runs a harmless tool call', async () => {
    const res = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { msg: 'ping' } } });
    expect(res.status).toBe(200);
    const body = await jsonFrom(res);
    expect(body.error).toBeUndefined();
    const result = body.result as { content: { text: string }[]; isError: boolean };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({ echo: 'ping' });
  });

  it('one client disconnecting does not disturb another', async () => {
    // Client A opens a stream and abandons it mid-response.
    const abandoned = await post(initialize(5));
    await abandoned.body?.cancel();

    const survivor = await post({ jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} });
    expect(survivor.status).toBe(200);
    expect((await jsonFrom(survivor)).result).toBeDefined();

    const stillInitializing = await post(initialize(7));
    expect(stillInitializing.status).toBe(200);
    await stillInitializing.text();
  });

  it('serves two real SDK clients concurrently, and survives one disconnecting', async () => {
    const requestInit = { headers: { Authorization: `Bearer ${TOKEN}` } };
    const a = new Client({ name: 'client-a', version: '1.0.0' });
    const b = new Client({ name: 'client-b', version: '1.0.0' });
    const ta = new StreamableHTTPClientTransport(new URL(ENDPOINT), { requestInit });
    const tb = new StreamableHTTPClientTransport(new URL(ENDPOINT), { requestInit });

    await a.connect(ta);
    await b.connect(tb);
    expect(a.getServerVersion()?.name).toBe('vargos');
    expect(b.getServerVersion()?.name).toBe('vargos');

    expect((await a.listTools()).tools.map(t => t.name)).toEqual(['echo']);
    expect((await b.listTools()).tools.map(t => t.name)).toEqual(['echo']);

    const callA = await a.callTool({ name: 'echo', arguments: { msg: 'ping' } });
    expect(callA.isError).toBeFalsy();

    await a.close();

    expect((await b.listTools()).tools.length).toBe(1);
    const callB = await b.callTool({ name: 'echo', arguments: { msg: 'still here' } });
    expect(callB.isError).toBeFalsy();
    expect(JSON.parse(String(callB.content[0].text))).toEqual({ echo: 'still here' });

    await b.close();
  });

  it('survives a client disconnecting during upload', async () => {
    const server = (edge as unknown as { httpServer: http.Server }).httpServer;
    const received = once(server, 'request');
    const req = http.request(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': '10000',
      },
    });
    req.on('error', () => {});
    req.write('{');
    const [incoming] = await received;
    const closed = once(incoming as http.IncomingMessage, 'close').catch(() => {});
    req.destroy();
    await closed;

    const res = await post(initialize(8));
    expect(res.status).toBe(200);
    await res.text();
  });

  it('keeps bearer auth enforced', async () => {
    const missing = await post(initialize(7), null);
    expect(missing.status).toBe(401);
    const wrong = await post(initialize(7), 'not-the-token');
    expect(wrong.status).toBe(401);
  });
});
