/**
 * Acceptance coverage for the core: loads real service modules from a temp dir through
 * the actual ServiceLoader, exercises all three surfaces (CLI projection, agent-tool
 * projection, JSON-RPC), reloads from disk, and checks bus semantics + dispose discipline.
 *
 * Ported from scripts/verify-core.ts, which ran the same assertions through a bespoke
 * pass/fail harness outside CI.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConnection } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import { EmitterBus } from '../bus.js';
import { ServiceLoader } from '../loader.js';
import { startRpcServer } from '../rpc-server.js';
import { buildParams, renderHelp, RpcClient } from '../cli.js';
import { bootLocal } from '../local.js';
import { MethodNotFoundError } from '../errors.js';
import type { MethodInfo } from '../types.js';

// Distinct from rpc-server.test.ts (19099) — vitest runs test files in parallel workers.
const RPC_PORT = 19097;
const DEAD_PORT = 19096;

const channelV1 = `
export function createService() {
  let timer;
  return {
    name: 'channel',
    init(bus) {
      bus.register('channel.send', {
        description: 'Send a message via a channel',
        schema: { safeParse: (p) => (p && typeof p.recipient === 'string' && typeof p.message === 'string')
          ? { success: true, data: p }
          : { success: false, error: { issues: [{ path: ['message'], message: 'Required' }] } } },
        cli: { positional: ['recipient', 'message'] },
      }, (p) => ({ sent: true, via: 'v1', to: p.recipient, text: p.message }));
      timer = setInterval(() => { globalThis.__ticks++; }, 25);
    },
    dispose() { clearInterval(timer); },
  };
}
`;

// v2: changed return value, removed channel.send, added channel.ping.
const channelV2 = `
export function createService() {
  let timer;
  return {
    name: 'channel',
    init(bus) {
      bus.register('channel.ping', {
        description: 'Ping',
        schema: { safeParse: (p) => ({ success: true, data: p ?? {} }) },
      }, () => ({ via: 'v2', pong: true }));
      timer = setInterval(() => { globalThis.__ticks++; }, 25);
    },
    dispose() { clearInterval(timer); },
  };
}
`;

const memory = `
export function createService() {
  return {
    name: 'memory',
    init(bus) {
      bus.register('memory.search', {
        description: 'Search memory',
        schema: { safeParse: (p) => (p && typeof p.query === 'string')
          ? { success: true, data: p }
          : { success: false, error: { issues: [{ path: ['query'], message: 'Required' }] } } },
        cli: { positional: ['query'] },
      }, (p) => [{ citation: 'MEMORY.md', content: 'found: ' + p.query }]);
    },
    dispose() {},
  };
}
`;

interface RpcResponse {
  result?: { sent?: boolean; pong?: boolean };
  error?: { code: number; message: string };
}

function rpcCall(port: number, body: object): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const s = createConnection({ host: '127.0.0.1', port }, () => s.write(JSON.stringify(body) + '\n'));
    let buf = '';
    s.on('data', (d) => { buf += d; if (buf.includes('\n')) { s.end(); resolve(JSON.parse(buf.split('\n')[0])); } });
    s.on('error', reject);
  });
}

const ticks = globalThis as typeof globalThis & { __ticks: number };

describe('core acceptance', () => {
  let dir: string;
  let chanPath: string;
  let bus: EmitterBus;
  let loader: ServiceLoader;
  let stopRpc: () => Promise<void>;
  let send: MethodInfo;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'vargos-acceptance-'));
    chanPath = path.join(dir, 'channel.mjs');
    const memPath = path.join(dir, 'memory.mjs');
    writeFileSync(chanPath, channelV1);
    writeFileSync(memPath, memory);
    ticks.__ticks = 0;

    bus = new EmitterBus();
    loader = new ServiceLoader(bus);
    await loader.load({ name: 'channel', modulePath: chanPath, priority: 0 });
    await loader.load({ name: 'memory', modulePath: memPath, priority: 0 });
    stopRpc = await startRpcServer(bus, '127.0.0.1', RPC_PORT);
    send = bus.list().find(m => m.name === 'channel.send')!;
  });

  afterAll(async () => {
    await loader.disposeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('one registration, three surfaces', () => {
    it('appears in the registry with its description', () => {
      expect(send).toBeDefined();
      expect(send.description).toBe('Send a message via a channel');
    });

    it('defaults to external exposure while keeping non-external tools available internally', async () => {
      expect(send.external).toBe(true);
      const localBus = new EmitterBus();
      localBus.register('private.action', {
        schema: z.object({}), description: 'Agent tool', external: false,
      }, () => 'ok');
      expect(localBus.list().filter(m => !m.internal)).toContainEqual(expect.objectContaining({
        name: 'private.action', external: false, internal: false,
      }));
      await expect(localBus.call('private.action', {})).resolves.toBe('ok');
    });

    it('renders description and arg shape in --help', () => {
      expect(renderHelp('channel', bus.list('channel'))).toContain('Send a message via a channel');
    });

    it('is invocable over the bus', async () => {
      await expect(bus.call('channel.send', { recipient: 'telegram:42', message: 'hi' }))
        .resolves.toEqual({ sent: true, via: 'v1', to: 'telegram:42', text: 'hi' });
    });

    it('is invocable over JSON-RPC', async () => {
      const res = await rpcCall(RPC_PORT, {
        jsonrpc: '2.0', method: 'channel.send', params: { recipient: 'x', message: 'y' }, id: 1,
      });
      expect(res.result?.sent).toBe(true);
    });

    it('is exposed to the agent-tool projection with a matching description', () => {
      const agentTools = bus.list().filter(m => !m.internal);
      expect(agentTools).toContainEqual(expect.objectContaining({
        name: 'channel.send',
        description: send.description,
      }));
    });
  });

  describe('CLI introspection', () => {
    it('scopes a service listing to that service alone', () => {
      const listed = bus.list('channel');
      expect(listed).toHaveLength(1);
      expect(listed.every(m => m.service === 'channel')).toBe(true);
    });

    it('derives the arg shape from a real zod schema', () => {
      // The stub schemas above can't be converted to JSON Schema, so this uses its own bus.
      const zbus = new EmitterBus();
      zbus.register('demo.send', {
        description: 'Send a message via a channel',
        schema: z.object({ recipient: z.string(), message: z.string() }),
        cli: { positional: ['recipient', 'message'] },
      }, () => ({}));
      expect(renderHelp('demo', zbus.list('demo'))).toMatch(/<recipient>.*<message>/s);
    });

    it('maps positional args onto schema keys', () => {
      expect(buildParams(send, ['telegram:7', 'hello'])).toEqual({ recipient: 'telegram:7', message: 'hello' });
    });

    it('reports a usage error — not a stack trace — on too many args', () => {
      expect(() => buildParams(send, ['a', 'b', 'c'])).toThrow(/too many arguments/);
    });

    it('reports the same validation failure on the bus and over RPC', async () => {
      await expect(bus.call('channel.send', { recipient: 'only' })).rejects.toThrow(/Invalid params/);
      const res = await rpcCall(RPC_PORT, { jsonrpc: '2.0', method: 'channel.send', params: { recipient: 'only' }, id: 2 });
      expect(res.error?.code).toBe(-32602);
    });
  });

  describe('bus semantics', () => {
    it('throws MethodNotFoundError for an unregistered method', async () => {
      await expect(bus.call('nope.missing')).rejects.toThrow(MethodNotFoundError);
      await expect(bus.call('nope.missing')).rejects.toMatchObject({ code: -32601 });
    });

    it('returns -32601 over RPC for an unregistered method', async () => {
      const res = await rpcCall(RPC_PORT, { jsonrpc: '2.0', method: 'nope.missing', params: {}, id: 3 });
      expect(res.error?.code).toBe(-32601);
    });

    it('treats emit with no listeners as a silent no-op', () => {
      expect(() => bus.emit('event.with.no.listeners', { a: 1 })).not.toThrow();
    });
  });

  describe('hot in-process reload', () => {
    const pid = process.pid;

    beforeAll(async () => {
      writeFileSync(chanPath, channelV2); // git pull simulation
      await loader.restart('channel');
    });

    it('stays in the same process', () => {
      expect(process.pid).toBe(pid);
    });

    it('observes the new code', async () => {
      await expect(bus.call('channel.ping')).resolves.toEqual({ via: 'v2', pong: true });
    });

    it('surfaces an added method everywhere', async () => {
      expect(bus.list('channel').some(m => m.name === 'channel.ping')).toBe(true);
      const res = await rpcCall(RPC_PORT, { jsonrpc: '2.0', method: 'channel.ping', id: 4 });
      expect(res.result?.pong).toBe(true);
    });

    it('drops a removed method everywhere', async () => {
      expect(bus.has('channel.send')).toBe(false);
      const res = await rpcCall(RPC_PORT, { jsonrpc: '2.0', method: 'channel.send', params: {}, id: 5 });
      expect(res.error?.code).toBe(-32601);
    });

    it('leaves other services untouched', async () => {
      await expect(bus.call('memory.search', { query: 'z' }))
        .resolves.toEqual([{ citation: 'MEMORY.md', content: 'found: z' }]);
    });

    it('clears the old interval on dispose — one timer running, not two', async () => {
      const before = ticks.__ticks;
      await new Promise(r => setTimeout(r, 250));
      const rate = (ticks.__ticks - before) / 0.25; // one 25ms interval ≈ 40/s; two would be ≈80/s
      expect(rate).toBeGreaterThan(20);
      expect(rate).toBeLessThan(60);
    });
  });

  describe('CLI ↔ daemon coexistence', () => {
    it('reports isUp() false with no daemon listening', async () => {
      await expect(new RpcClient('127.0.0.1', DEAD_PORT).isUp()).resolves.toBe(false);
    });

    it('boots and disposes a local stack with only the services asked for', async () => {
      await stopRpc();
      const stack = await bootLocal(['config'], path.resolve('.'), 'ts');
      expect(stack.bus.list('config').some(m => m.name === 'config.get')).toBe(true);
      await expect(stack.dispose()).resolves.not.toThrow();
    });
  });
});
