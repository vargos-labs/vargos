import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebhooksEdge } from '../index.js';

type Call = { method: string; params: unknown };

/** Instantiate the edge with a stubbed bus and expose the private fireHook. */
function stubEdge(calls: Call[]) {
  const edge = new WebhooksEdge() as unknown as {
    bus: { call: (m: string, p: unknown) => Promise<unknown> };
    fireHook: (hook: { id: string; name: string; transform?: string; notify?: string[] }, payload: unknown) => Promise<void>;
  };
  edge.bus = {
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      return method === 'agent.execute' ? { response: 'done' } : {};
    }),
  };
  return edge;
}

describe('webhook transform — null/undefined skip', () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'webhooks-skip-'));
    process.env.VARGOS_DATA_DIR = dataDir;
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.VARGOS_DATA_DIR;
  });

  it('forwards shared overrides from a transform', async () => {
    writeFileSync(path.join(dataDir, 'options.js'), `export default () => ({ task: 'Research', reasoningEffort: 'low', allowedTools: ['memory.*'], skills: ['research'] });`);
    const calls: Call[] = [];
    await stubEdge(calls).fireHook({ id: 'options', name: 'x', transform: 'options.js' }, {});
    expect(calls.find(call => call.method === 'agent.execute')?.params).toMatchObject({ reasoningEffort: 'low', allowedTools: ['memory.*'], skills: ['research'] });
  });
  it('skips agent.execute and notify delivery when transform returns null', async () => {
    writeFileSync(path.join(dataDir, 'skip-null.js'), 'export default () => null;');
    const calls: Call[] = [];
    const edge = stubEdge(calls);
    await edge.fireHook({ id: 'skip-null', name: 'x', transform: 'skip-null.js' }, {});
    expect(calls).toHaveLength(0);
  });

  it('skips when transform returns undefined', async () => {
    writeFileSync(path.join(dataDir, 'skip-undef.js'), 'export default () => undefined;');
    const calls: Call[] = [];
    const edge = stubEdge(calls);
    await edge.fireHook({ id: 'skip-undef', name: 'x', transform: 'skip-undef.js' }, {});
    expect(calls).toHaveLength(0);
  });

  it('skips when transform returns an empty string', async () => {
    writeFileSync(path.join(dataDir, 'skip-empty.js'), 'export default () => "";');
    const calls: Call[] = [];
    const edge = stubEdge(calls);
    await edge.fireHook({ id: 'skip-empty', name: 'x', transform: 'skip-empty.js' }, {});
    expect(calls).toHaveLength(0);
  });

  it('still executes and notifies when transform returns a string', async () => {
    writeFileSync(path.join(dataDir, 'keep.js'), 'export default () => "DO THE THING";');
    const calls: Call[] = [];
    const edge = stubEdge(calls);
    await edge.fireHook({ id: 'keep', name: 'x', transform: 'keep.js', notify: ['telegram:u1'] }, {});
    expect(calls.map(c => c.method)).toEqual(['agent.execute', 'channel.send']);
    expect(calls[0].params).toMatchObject({ task: 'DO THE THING' });
  });

  it('propagates task/cwd/model when transform returns an object', async () => {
    writeFileSync(path.join(dataDir, 'obj.js'), 'export default () => ({ task: "OBJ TASK", cwd: "/tmp/somewhere", model: "vargos-110:vllm" });');
    const calls: Call[] = [];
    const edge = stubEdge(calls);
    await edge.fireHook({ id: 'obj', name: 'x', transform: 'obj.js' }, {});
    expect(calls.map(c => c.method)).toEqual(['agent.execute']);
    expect(calls[0].params).toMatchObject({ task: 'OBJ TASK', cwd: '/tmp/somewhere', model: 'vargos-110:vllm' });
  });

  it('omits cwd/model from agent.execute when the object return leaves them unset', async () => {
    writeFileSync(path.join(dataDir, 'obj-min.js'), 'export default () => ({ task: "OBJ MIN" });');
    const calls: Call[] = [];
    const edge = stubEdge(calls);
    await edge.fireHook({ id: 'obj-min', name: 'x', transform: 'obj-min.js' }, {});
    expect(calls.map(c => c.method)).toEqual(['agent.execute']);
    expect(calls[0].params).toMatchObject({ task: 'OBJ MIN' });
    // "" would resolve to the daemon's process.cwd() in the SDK — the keys must be absent, not empty.
    expect(calls[0].params).not.toHaveProperty('cwd');
    expect(calls[0].params).not.toHaveProperty('model');
  });

  it('skips when transform returns an object with an empty task', async () => {
    writeFileSync(path.join(dataDir, 'obj-empty.js'), 'export default () => ({ task: "" });');
    const calls: Call[] = [];
    const edge = stubEdge(calls);
    await edge.fireHook({ id: 'obj-empty', name: 'x', transform: 'obj-empty.js' }, {});
    expect(calls).toHaveLength(0);
  });

  it('skips when transform returns an object without a task', async () => {
    writeFileSync(path.join(dataDir, 'obj-notask.js'), 'export default () => ({});');
    const calls: Call[] = [];
    const edge = stubEdge(calls);
    await edge.fireHook({ id: 'obj-notask', name: 'x', transform: 'obj-notask.js' }, {});
    expect(calls).toHaveLength(0);
  });
});
