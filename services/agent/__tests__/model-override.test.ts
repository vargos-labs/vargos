import type { AgentOptions } from '../../config/schemas/agent.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentService } from '../index.js';
import { AppConfigSchema } from '../../config/index.js';
import type { Bus } from '../../../core/types.js';
import { resetDataPaths } from '../../../lib/paths.js';
import type { AgentSession, CreateAgentSessionOptions, CreateAgentSessionResult } from '@earendil-works/pi-coding-agent';

// ── Fakes ──────────────────────────────────────────────────────────────────

interface FakeModel { provider: string; id: string; }

function fakeSession(model?: FakeModel) {
  const session = {
    model,
    setModel: vi.fn(async (m: FakeModel) => { session.model = m; }),
    subscribe: vi.fn(),
    systemPrompt: '',
    state: { messages: [] },
    dispose: vi.fn(),
  };
  return session as unknown as AgentSession & { setModel: ReturnType<typeof vi.fn> };
}

const MODELS_JSON = JSON.stringify({
  providers: {
    test: {
      baseUrl: 'http://localhost:1234', api: 'openai-completions', apiKey: 'test-key',
      models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }],
    },
    // Provider id contains a colon (real local vLLM providers look like this).
    'local:vllm': {
      baseUrl: 'http://localhost:1235', api: 'openai-completions', apiKey: 'local',
      models: [{ id: 'model-a', name: 'Local A' }, { id: 'model:colon', name: 'Local colon model' }, { id: 'model:a', name: 'Ambiguous local model' }],
    },
    // Provider id is a prefix of another provider id — used for the ambiguity rule.
    'local:vllm:model': {
      baseUrl: 'http://localhost:1236', api: 'openai-completions', apiKey: 'local',
      models: [{ id: 'a', name: 'Ambiguous A' }],
    },
    // Plain provider whose model id contains a colon (built-in catalog ships ids like this).
    test2: {
      baseUrl: 'http://localhost:1237', api: 'openai-completions', apiKey: 'test-key',
      models: [{ id: 'model:colon', name: 'Colon Model' }],
    },
  },
});

class TestableRuntime extends AgentService {
  lastCreateOptions?: CreateAgentSessionOptions;
  fakeForCreate = fakeSession({ provider: 'test', id: 'model-a' });

  protected createPiSession(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> {
    this.lastCreateOptions = options;
    return Promise.resolve({ session: this.fakeForCreate } as unknown as CreateAgentSessionResult);
  }
  testGetOrCreate(key: string, opts?: AgentOptions & { cwd?: string }) {
    return this.getOrCreateSession(key, opts);
  }
  inject(key: string, session: AgentSession) {
    this.sessions.set(key, session);
    this.sessionMeta.set(key, Date.now());
  }
}

async function createRuntime(dataDir: string, toolNames: string[] = []): Promise<TestableRuntime> {
  const config = AppConfigSchema.parse({
    providers: { test: { baseUrl: 'http://localhost:1234', apiKey: 'test-key', api: 'openai-completions', models: [{ id: 'model-a', name: 'Model A' }] } },
    agent: { model: 'test:model-a' },
  });

  process.env.VARGOS_DATA_DIR = dataDir;
  resetDataPaths();

  const bus = {
    call: async (event: string) => (event === 'config.get' ? config : {}),
    register: () => () => {},
    on: () => () => {},
    emit: () => {},
    has: () => false,
    list: () => toolNames.map(name => ({ name, description: name, schema: {}, internal: false, live: false })),
  } as unknown as Bus;

  const runtime = new TestableRuntime();
  await runtime.init(bus);
  return runtime;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('agent model override', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `model-override-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(path.join(tmpDir, 'workspace'), { recursive: true });
    mkdirSync(path.join(tmpDir, 'agent'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'agent', 'models.json'), MODELS_JSON);
    originalEnv = process.env.VARGOS_DATA_DIR;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.VARGOS_DATA_DIR;
    else process.env.VARGOS_DATA_DIR = originalEnv;
    resetDataPaths();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applies the override when creating a new session', async () => {
    const runtime = await createRuntime(tmpDir);
    runtime.fakeForCreate = fakeSession({ provider: 'test', id: 'model-b' });
    await runtime.testGetOrCreate('telegram:u1', { model: 'test:model-b' });
    expect(runtime.lastCreateOptions?.model).toMatchObject({ provider: 'test', id: 'model-b' });
  });

  it('keeps resource selections on reuse and rejects silent changes', async () => {
    const runtime = await createRuntime(tmpDir);
    await runtime.testGetOrCreate('cron:test', { skills: ['research'], allowedTools: ['memory.*'] });
    await expect(runtime.testGetOrCreate('cron:test')).resolves.toBe(runtime.fakeForCreate);
    await expect(runtime.testGetOrCreate('cron:test', { skills: ['other'] })).rejects.toThrow('new agent session');
    await expect(runtime.testGetOrCreate('cron:test', { allowedTools: ['web.*'] })).rejects.toThrow('new agent session');
  });

  it('compares resource selections without order or duplicate sensitivity', async () => {
    const runtime = await createRuntime(tmpDir);
    await runtime.testGetOrCreate('cron:test', { skills: ['research', 'writing'], allowedTools: ['memory.*', 'web.*'] });
    await expect(runtime.testGetOrCreate('cron:test', { skills: ['writing', 'research', 'research'], allowedTools: ['web.*', 'memory.*'] })).resolves.toBe(runtime.fakeForCreate);
  });

  it('narrows subagent tools and discovered skills without widening persona restrictions', async () => {
    mkdirSync(path.join(tmpDir, 'agents'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'agents/subagent.md'), '---\nallowedTools: [memory.*]\nskills: [research]\n---\nFocused worker');
    for (const name of ['research', 'writing']) {
      const directory = path.join(tmpDir, 'agent/skills', name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\nInstructions`);
    }
    const runtime = await createRuntime(tmpDir, ['memory.search', 'channel.send', 'agent.execute']);
    await runtime.testGetOrCreate('cli:adhoc:subagent:one', { allowedTools: ['*'], skills: ['*'] });
    expect(runtime.lastCreateOptions?.customTools?.map(tool => tool.label)).toEqual(['memory.search']);
    expect(runtime.lastCreateOptions?.resourceLoader?.getSkills().skills.map(skill => skill.name)).toEqual(['research']);
    await runtime.testGetOrCreate('cli:adhoc:subagent:two', { allowedTools: ['channel.send'], skills: ['writing'] });
    expect(runtime.lastCreateOptions?.customTools).toEqual([]);
    expect(runtime.lastCreateOptions?.resourceLoader?.getSkills().skills).toEqual([]);
  });

  it('switches the model on a cached session', async () => {
    const runtime = await createRuntime(tmpDir);
    const cached = fakeSession({ provider: 'test', id: 'model-a' });
    runtime.inject('telegram:u1', cached);
    const returned = await runtime.testGetOrCreate('telegram:u1', { model: 'test:model-b' });
    expect((cached as unknown as { setModel: ReturnType<typeof vi.fn> }).setModel)
      .toHaveBeenCalledWith(expect.objectContaining({ provider: 'test', id: 'model-b' }));
    expect(returned.model).toMatchObject({ provider: 'test', id: 'model-b' });
  });

  it('is a no-op when the override matches the cached model', async () => {
    const runtime = await createRuntime(tmpDir);
    const cached = fakeSession({ provider: 'test', id: 'model-a' });
    runtime.inject('telegram:u1', cached);
    await runtime.testGetOrCreate('telegram:u1', { model: 'test:model-a' });
    expect((cached as unknown as { setModel: ReturnType<typeof vi.fn> }).setModel).not.toHaveBeenCalled();
  });

  it('does not touch the model on a cached session when no override is given', async () => {
    const runtime = await createRuntime(tmpDir);
    const cached = fakeSession({ provider: 'test', id: 'model-a' });
    runtime.inject('telegram:u1', cached);
    await runtime.testGetOrCreate('telegram:u1');
    expect((cached as unknown as { setModel: ReturnType<typeof vi.fn> }).setModel).not.toHaveBeenCalled();
  });

  it('omits the model option entirely when no override is given on creation', async () => {
    const runtime = await createRuntime(tmpDir);
    await runtime.testGetOrCreate('telegram:u3');
    expect(runtime.lastCreateOptions).toBeDefined();
    expect('model' in runtime.lastCreateOptions!).toBe(false);
  });

  it('keeps the default model when the override is unknown', async () => {
    const runtime = await createRuntime(tmpDir);
    const cached = fakeSession({ provider: 'test', id: 'model-a' });
    runtime.inject('telegram:u1', cached);
    const returned = await runtime.testGetOrCreate('telegram:u1', { model: 'bogus:nope' });
    expect((cached as unknown as { setModel: ReturnType<typeof vi.fn> }).setModel).not.toHaveBeenCalled();
    expect(returned.model).toMatchObject({ provider: 'test', id: 'model-a' });
  });

  it('honors the cwd override on a cache miss', async () => {
    const runtime = await createRuntime(tmpDir);
    const cwd = path.join(tmpDir, 'project');
    mkdirSync(cwd, { recursive: true });
    await runtime.testGetOrCreate('telegram:u2', { cwd });
    expect(runtime.lastCreateOptions?.cwd).toBe(cwd);
  });

  it('resolves a model when the provider id contains a colon', async () => {
    const runtime = await createRuntime(tmpDir);
    runtime.fakeForCreate = fakeSession({ provider: 'local:vllm', id: 'model-a' });
    await runtime.testGetOrCreate('telegram:u4', { model: 'local:vllm:model-a' });
    expect(runtime.lastCreateOptions?.model).toMatchObject({ provider: 'local:vllm', id: 'model-a' });
  });

  it('resolves a model when the model id contains a colon', async () => {
    const runtime = await createRuntime(tmpDir);
    runtime.fakeForCreate = fakeSession({ provider: 'test2', id: 'model:colon' });
    await runtime.testGetOrCreate('telegram:u5', { model: 'test2:model:colon' });
    expect(runtime.lastCreateOptions?.model).toMatchObject({ provider: 'test2', id: 'model:colon' });
  });

  it('resolves when BOTH the provider and the model id contain colons', async () => {
    const runtime = await createRuntime(tmpDir);
    runtime.fakeForCreate = fakeSession({ provider: 'local:vllm', id: 'model:colon' });
    await runtime.testGetOrCreate('telegram:u6', { model: 'local:vllm:model:colon' });
    expect(runtime.lastCreateOptions?.model).toMatchObject({ provider: 'local:vllm', id: 'model:colon' });
  });

  it('prefers the longest provider id when a spec is ambiguous', async () => {
    const runtime = await createRuntime(tmpDir);
    // "local:vllm:model:a" can be (local:vllm / model:a) or (local:vllm:model / a) — both exist.
    runtime.fakeForCreate = fakeSession({ provider: 'local:vllm:model', id: 'a' });
    await runtime.testGetOrCreate('telegram:u7', { model: 'local:vllm:model:a' });
    expect(runtime.lastCreateOptions?.model).toMatchObject({ provider: 'local:vllm:model', id: 'a' });
  });

  it('rejects a leading-colon spec', async () => {
    const runtime = await createRuntime(tmpDir);
    const cached = fakeSession({ provider: 'test', id: 'model-a' });
    runtime.inject('telegram:u8', cached);
    const returned = await runtime.testGetOrCreate('telegram:u8', { model: ':model-a' });
    expect((cached as unknown as { setModel: ReturnType<typeof vi.fn> }).setModel).not.toHaveBeenCalled();
    expect(returned.model).toMatchObject({ provider: 'test', id: 'model-a' });
  });

  it('rejects a trailing-colon spec', async () => {
    const runtime = await createRuntime(tmpDir);
    const cached = fakeSession({ provider: 'test', id: 'model-a' });
    runtime.inject('telegram:u9', cached);
    const returned = await runtime.testGetOrCreate('telegram:u9', { model: 'test:' });
    expect((cached as unknown as { setModel: ReturnType<typeof vi.fn> }).setModel).not.toHaveBeenCalled();
    expect(returned.model).toMatchObject({ provider: 'test', id: 'model-a' });
  });
});
