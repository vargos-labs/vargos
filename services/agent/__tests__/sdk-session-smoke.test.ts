/**
 * Real-SDK smoke: exercises the *actual* Pi SDK session path (no `createPiSession` stub)
 * — ModelRuntime/ModelRegistry, SettingsManager, DefaultResourceLoader, SessionManager,
 * createAgentSession, and the appendMessage + exportToJsonl seam. No model call is made,
 * so no network.
 *
 * Guards against Pi SDK upgrades silently breaking session creation, model resolution,
 * session-file layout, or the history-append path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentService } from '../index.js';
import { AppConfigSchema } from '../../config/index.js';
import type { Bus } from '../../../core/types.js';
import { resetDataPaths } from '../../../lib/paths.js';

class SmokeAgent extends AgentService {
  open(key: string, opts?: { model?: string }) {
    return this.getOrCreateSession(key, opts);
  }
}

const MODELS_JSON = JSON.stringify({
  providers: {
    test: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'x', models: [{ id: 'model-a', name: 'A' }] },
  },
});

describe('Pi SDK session smoke (real SDK path)', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `sdk-smoke-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(path.join(tmpDir, 'workspace'), { recursive: true });
    mkdirSync(path.join(tmpDir, 'agent'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'agent', 'models.json'), MODELS_JSON);
    writeFileSync(path.join(tmpDir, 'agent', 'auth.json'), '{}');
    originalEnv = process.env.VARGOS_DATA_DIR;
    process.env.VARGOS_DATA_DIR = tmpDir;
    resetDataPaths();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.VARGOS_DATA_DIR;
    else process.env.VARGOS_DATA_DIR = originalEnv;
    resetDataPaths();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createRuntime(): Promise<SmokeAgent> {
    const config = AppConfigSchema.parse({
      providers: { test: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', api: 'openai-completions', models: [{ id: 'model-a', name: 'A' }] } },
      agent: { model: 'test:model-a' },
    });
    const bus = {
      call: async (e: string) => (e === 'config.get' ? config : {}),
      register: () => () => {}, on: () => () => {}, emit: () => {}, has: () => false, list: () => [],
    } as unknown as Bus;
    const runtime = new SmokeAgent();
    await runtime.init(bus);
    return runtime;
  }

  it('creates a real session and resolves the model', async () => {
    const runtime = await createRuntime();
    const session = await runtime.open('telegram:smoke', { model: 'test:model-a' });

    expect(session.model).toMatchObject({ provider: 'test', id: 'model-a' });
    expect(session.sessionManager.getSessionFile()?.endsWith('.jsonl')).toBe(true);

    runtime.dispose();
  });

  it('appends history and flushes it to disk (channel.send / observe seam)', async () => {
    const runtime = await createRuntime();
    const session = await runtime.open('telegram:smoke2');

    const file = session.sessionManager.getSessionFile();
    expect(file).toBeDefined();

    session.sessionManager.appendMessage({ role: 'user', content: 'smoke-append', timestamp: Date.now() });
    // Vargos forces the deferred JSONL write so other instances see the history immediately.
    session.exportToJsonl(file!);

    expect(existsSync(file!)).toBe(true);
    expect(readFileSync(file!, 'utf-8')).toContain('smoke-append');

    runtime.dispose();
  });
});
