import { VoiceRuntimeSchema, type VoiceRuntimeConfig } from '../../config/schemas/voice.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { EmitterBus } from '../../../core/bus.js';
import { resetDataPaths } from '../../../lib/paths.js';
import { VoiceService, stopVoiceProcess, voiceRuntimeDir } from '../index.js';

import { RpcClient } from '../../../core/rpc-client.js';

const realSpawn = spawn;
function spawnWorker(withChild = false) {
  return realSpawn(process.execPath, ['-e', withChild ? `
    const {spawn}=require('node:child_process');
    const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    console.log(worker.pid); setInterval(()=>{},1000);
  ` : 'setInterval(()=>{},1000)'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

let service: VoiceService | undefined;
let temp: string | undefined;
afterEach(async () => {
  await service?.dispose(); service = undefined;
  if (temp) await rm(temp, { recursive: true, force: true });
  temp = undefined; vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetDataPaths();
});
async function setup(voice?: { enabled: boolean }, transport: Partial<VoiceRuntimeConfig> = {}, installed = false) {
  syncBuiltinESMExports();
  temp = await mkdtemp(path.join(os.tmpdir(), 'vargos-voice-test-'));
  vi.stubEnv('XDG_CACHE_HOME', temp); vi.stubEnv('VARGOS_CLI_ONESHOT', ''); resetDataPaths();
  if (installed) {
    await mkdir(voiceRuntimeDir(), { recursive: true });
    await writeFile(path.join(voiceRuntimeDir(), 'ready'), '');
  }
  const bus = new EmitterBus();
  bus.register('config.get', { schema: z.object({}), description: 'test config' }, () => ({ gateway: { host: '127.0.0.1', port: 9000 }, agent: { voice }, voice: VoiceRuntimeSchema.parse(transport) }));
  service = new VoiceService(); await service.init(bus); return bus;
}
describe('optional managed speech runtime', () => {
  it.each([
    [undefined, {}, true],
    [{ enabled: true }, {}, false],
    [{ enabled: true }, { externalUrl: 'wss://voice.example/v1/realtime' }, true],
  ] as const)('does not launch for disabled, missing, or external runtime (%j)', async (voice, transport, installed) => {
    const launch = vi.spyOn(childProcess, 'spawn');
    const probe = vi.spyOn(RpcClient.prototype, 'isUp').mockResolvedValue(true);
    const bus = await setup(voice, transport, installed);
    bus.emit('bus.onReady', {});
    await Promise.resolve();
    expect(launch).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });
  it.each([false, true])('starts once on readiness or reload (gateway ready: %s)', async ready => {
    vi.spyOn(RpcClient.prototype, 'isUp').mockResolvedValue(ready);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const launch = vi.spyOn(childProcess, 'spawn').mockImplementation(() => spawnWorker());
    const bus = await setup({ enabled: true }, {}, true);
    await Promise.resolve();
    expect(launch).toHaveBeenCalledTimes(ready ? 1 : 0);
    bus.emit('bus.onReady', {});
    bus.emit('bus.onReady', {});
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it.skipIf(process.platform !== 'linux')('cleans orphan workers before retrying an unexpectedly killed wrapper', async () => {
    vi.spyOn(RpcClient.prototype, 'isUp').mockResolvedValue(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const launch = vi.spyOn(childProcess, 'spawn').mockImplementation(() => spawnWorker(true));
    await setup({ enabled: true }, {}, true);
    const wrapper = launch.mock.results[0].value;
    const [data] = await once(wrapper.stdout, 'data');
    const workerPid = Number(String(data).trim());
    wrapper.kill('SIGKILL');
    await vi.waitFor(async () => {
      const state = await readFile(`/proc/${workerPid}/stat`, 'utf8').catch(() => '');
      expect(!state || state.split(' ')[2] === 'Z').toBe(true);
    });
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2), { timeout: 2000 });
  });
  it('rejects conflicting ports and non-WebSocket external endpoints', () => {
    expect(VoiceRuntimeSchema.safeParse({ port: 1234, adapterPort: 1234 }).success).toBe(false);
    expect(VoiceRuntimeSchema.safeParse({ externalUrl: 'https://voice.example' }).success).toBe(false);
  });
  it.skipIf(process.platform !== 'linux')('stops the wrapper and its subprocess group', async () => {
    const child = spawn(process.execPath, ['-e', `
      const {spawn}=require('node:child_process');
      const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      console.log(worker.pid); setInterval(()=>{},1000);
    `], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const [data] = await once(child.stdout!, 'data');
      const workerPid = Number(String(data).trim());
      expect(workerPid).toBeGreaterThan(1);
      await stopVoiceProcess(child);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      const state = await readFile(`/proc/${workerPid}/stat`, 'utf8').catch(() => '');
      expect(!state || state.split(' ')[2] === 'Z').toBe(true);
    } finally { await stopVoiceProcess(child); }
  });
});
