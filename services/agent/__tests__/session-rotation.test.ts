import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentService } from '../index.js';
import { AppConfigSchema } from '../../config/index.js';
import { resetDataPaths } from '../../../lib/paths.js';
import type { Bus } from '../../../core/types.js';
import { SessionManager, type AgentSession, type AgentSessionEvent, type ModelRuntime } from '@earendil-works/pi-coding-agent';

const key = 'test-channel:chat';
const result = (text = 'Goal: finish deployment. Next: verify release.', stopReason = 'stop') =>
  ({ content: [{ type: 'text', text }], stopReason }) as Awaited<ReturnType<ModelRuntime['completeSimple']>>;

class RotationAgent extends AgentService {
  open() { return this.getOrCreateSession(key, { model: 'test:model-a' }); }
  summarize() { return vi.spyOn(this.modelRuntime, 'completeSimple').mockResolvedValue(result()); }
  running() { this.activeRuns.add(key); }
  idle() { this.activeRuns.delete(key); }
  failCreation() { vi.spyOn(this, 'createPiSession').mockRejectedValueOnce(new Error('Creation failed')); }
  failSeeding(old: AgentSession) {
    const create = this.createPiSession.bind(this);
    vi.spyOn(this, 'createPiSession').mockImplementationOnce(async options => {
      const created = await create(options);
      vi.spyOn(created.session.sessionManager, 'appendMessage').mockImplementationOnce(() => {
        expect(this.sessions.get(key)).toBe(old);
        throw new Error('Disk full');
      });
      return created;
    });
  }
  busyChild() {
    this.sessions.set(`${key}:subagent:child`, { isIdle: false, dispose: vi.fn() } as unknown as AgentSession);
  }
  compact(session: AgentSession, after?: number, reason = 'threshold') {
    (session as unknown as { _emit: (event: AgentSessionEvent) => void })._emit({
      type: 'compaction_end', reason, aborted: false, willRetry: false,
      result: { summary: 'Current objective\n<read-files>old-path</read-files>', tokensBefore: 30000, estimatedTokensAfter: after, firstKeptEntryId: 'kept' },
    } as AgentSessionEvent);
  }
}

describe('post-compaction session rotation', () => {
  let dir: string;
  let runtime: RotationAgent;
  let call: ReturnType<typeof vi.fn>;
  let emit: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'vargos-rotation-'));
    mkdirSync(path.join(dir, 'agent'));
    mkdirSync(path.join(dir, 'workspace'));
    const providers = { test: { api: 'openai-completions', apiKey: 'test', baseUrl: 'http://127.0.0.1:1/v1',
      models: [{ id: 'model-a', name: 'A', contextWindow: 32768, maxTokens: 4096 }] } };
    writeFileSync(path.join(dir, 'agent', 'models.json'), JSON.stringify({ providers }));
    writeFileSync(path.join(dir, 'agent', 'auth.json'), '{}');
    vi.stubEnv('VARGOS_DATA_DIR', dir);
    resetDataPaths();
    const config = AppConfigSchema.parse({ providers, channels: [{ id: 'test-channel', type: 'whatsapp', enabled: false }] });
    call = vi.fn(async (method: string) => method === 'config.get' ? config : {});
    emit = vi.fn();
    const bus = { emit, call,
      register: () => () => {}, on: () => () => {}, has: () => false, list: () => [] } as unknown as Bus;
    runtime = new RotationAgent();
    await runtime.init(bus);
  });

  afterEach(() => {
    runtime.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetDataPaths();
    rmSync(dir, { recursive: true, force: true });
  });

  async function oldSession() {
    const session = await runtime.open();
    session.sessionManager.appendMessage({ role: 'user', content: 'Latest task: deploy and verify the release.', timestamp: Date.now() });
    session.refreshContext();
    return session;
  }

  it('emits completion only after the compaction continuation settles', async () => {
    const session = await oldSession();
    const fire = (event: AgentSessionEvent) =>
      (session as unknown as { _emit: (event: AgentSessionEvent) => void })._emit(event);
    const prompt = vi.spyOn(session, 'prompt').mockResolvedValue(undefined);
    fire({ type: 'agent_end', messages: [], willRetry: false });
    runtime.compact(session, 100);
    expect(prompt).toHaveBeenCalled();
    fire({ type: 'agent_end', messages: [], willRetry: false });
    expect(emit).not.toHaveBeenCalledWith('agent.onCompleted', expect.anything());
    session.sessionManager.appendMessage({ ...result('Final answer.'), role: 'assistant', timestamp: Date.now() });
    session.refreshContext();
    fire({ type: 'agent_settled' });
    expect(emit).toHaveBeenCalledWith('agent.onCompleted', { sessionKey: key, success: true, response: 'Final answer.' });
    expect(emit.mock.calls.filter(([name]) => name === 'agent.onCompleted')).toHaveLength(1);
  });

  it.each([100, 16384, undefined])('keeps the current session at/below 50%% or with unknown usage (%s)', async after => {
    const old = await oldSession();
    const summarize = runtime.summarize();
    vi.spyOn(old, 'prompt').mockResolvedValue(undefined);
    runtime.compact(old, after);
    expect(await runtime.open()).toBe(old);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('defers replacement until idle and preserves model, history, and the same channel key', async () => {
    const old = await oldSession();
    const oldId = old.sessionId;
    const oldFile = old.sessionManager.getSessionFile()!;
    const transcript = readFileSync(oldFile, 'utf8');
    const summarize = runtime.summarize();
    runtime.running();
    const prompt = vi.spyOn(old, 'prompt').mockResolvedValue(undefined);
    runtime.compact(old, 20000);
    expect(prompt).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledWith('channel.send', { sessionKey: key, text: expect.stringContaining('30000 → 20000') });
    expect(await runtime.open()).toBe(old);
    expect(summarize).not.toHaveBeenCalled();
    runtime.idle();
    const fresh = await runtime.open();
    expect(fresh).not.toBe(old);
    expect(fresh.sessionId).not.toBe(oldId);
    expect(fresh.model?.id).toBe(old.model?.id);
    expect(fresh.sessionManager.isPersisted()).toBe(true);
    expect(existsSync(oldFile)).toBe(false);
    const archiveDir = path.join(dir, 'archive', 'sessions', 'test-channel', 'chat');
    const archive = path.join(archiveDir, readdirSync(archiveDir)[0]);
    expect(readFileSync(archive, 'utf8')).toBe(transcript);
    const reopened = SessionManager.open(fresh.sessionManager.getSessionFile()!);
    expect(JSON.stringify(reopened.buildSessionContext().messages)).toContain('Next: verify release.');
    expect(JSON.stringify(fresh.state.messages)).toContain(archive);
    expect(call).toHaveBeenCalledWith('channel.send', { sessionKey: key, text: expect.stringContaining('Started a fresh session') });
    const request = summarize.mock.calls[0][1];
    expect(JSON.stringify(request)).toContain('Latest task: deploy');
    expect(JSON.stringify(request)).not.toContain('old-path');
    expect(request.tools).toBeUndefined();
    expect(summarize.mock.calls[0][2]).toMatchObject({ maxTokens: 2000 });
  });

  it.each([
    ['empty', '', 'stop'], ['oversized', 'word '.repeat(10000), 'stop'], ['truncated', 'partial', 'length'],
  ])('retains the original session for a %s handoff and retries on the next idle access', async (_label, text, stop) => {
    const old = await oldSession();
    const file = old.sessionManager.getSessionFile()!;
    const transcript = readFileSync(file, 'utf8');
    const summarize = runtime.summarize().mockResolvedValueOnce(result(text, stop));
    runtime.compact(old, 20000);
    expect(await runtime.open()).toBe(old);
    expect(readFileSync(file, 'utf8')).toBe(transcript);
    expect(call).not.toHaveBeenCalledWith('channel.send', expect.objectContaining({ text: expect.stringContaining('Started a fresh session') }));
    expect(await runtime.open()).not.toBe(old);
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it('preserves the old transcript on provider, archive, or session-creation failure', async () => {
    const old = await oldSession();
    const file = old.sessionManager.getSessionFile()!;
    const summarize = runtime.summarize().mockRejectedValueOnce(new Error('Provider unavailable'));
    runtime.compact(old, 20000);
    expect(await runtime.open()).toBe(old);
    expect(existsSync(file)).toBe(true);
    writeFileSync(path.join(dir, 'archive'), 'not a directory');
    expect(await runtime.open()).toBe(old);
    rmSync(path.join(dir, 'archive'));
    runtime.failCreation();
    expect(await runtime.open()).toBe(old);
    expect(existsSync(file)).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(3);
  });

  it('does not rotate while the SDK itself is busy', async () => {
    const old = await oldSession();
    const summarize = runtime.summarize();
    vi.spyOn(old, 'isIdle', 'get').mockReturnValue(false);
    runtime.compact(old, 20000);
    expect(await runtime.open()).toBe(old);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('restores the old cached session if persisting the handoff fails', async () => {
    const old = await oldSession();
    const file = old.sessionManager.getSessionFile()!;
    const transcript = readFileSync(file, 'utf8');
    runtime.summarize();
    runtime.compact(old, 20000);
    runtime.failSeeding(old);
    expect(await runtime.open()).toBe(old);
    expect(readFileSync(file, 'utf8')).toBe(transcript);
  });

  it('defers rotation while a child session is busy', async () => {
    const old = await oldSession();
    const summarize = runtime.summarize();
    runtime.busyChild();
    runtime.compact(old, 20000);
    expect(await runtime.open()).toBe(old);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('runs a single rotation for concurrent accesses', async () => {
    const old = await oldSession();
    const summarize = runtime.summarize();
    runtime.compact(old, 20000);
    const [a, b] = await Promise.all([runtime.open(), runtime.open()]);
    expect(a).toBe(b);
    expect(a).not.toBe(old);
    expect(summarize).toHaveBeenCalledTimes(1);
  });
});
