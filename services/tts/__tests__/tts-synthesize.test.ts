/**
 * Unit tests for the TTS device (tts.synthesize).
 * Stubs the OpenAI-compatible /v1/audio/speech endpoint via global fetch and
 * verifies request shape, default voice, and output file location.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { EmitterBus } from '../../../core/bus.js';
import { TtsService } from '../index.js';
import { getDataPaths, resetDataPaths } from '../../../lib/paths.js';
import type { AppConfig } from '../../config/index.js';

const testConfig = {
  agent: { media: { tts: 'openai:tts-1', voice: 'default-voice' } },
  auth: { openai: { type: 'api_key', key: 'sk-test' } },
  providers: { openai: { baseUrl: 'http://127.0.0.1:9/v1' } },
} as unknown as AppConfig;

describe('tts.synthesize', () => {
  let tempDir: string;
  let bus: EmitterBus;
  let service: TtsService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `tts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
    process.env.VARGOS_DATA_DIR = tempDir;
    resetDataPaths();

    const mp3Bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04]);
    fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => mp3Bytes.buffer,
      _body: JSON.parse(String(init?.body)),
    }));
    vi.stubGlobal('fetch', fetchMock);

    bus = new EmitterBus();
    bus.beginLoading('config');
    bus.register('config.get', { description: 'test', schema: z.object({}) }, () => testConfig);
    bus.endLoading();

    service = new TtsService();
    bus.beginLoading('tts');
    await service.init(bus);
    bus.endLoading();
  });

  afterEach(async () => {
    service.dispose();
    bus.releaseService('tts');
    vi.unstubAllGlobals();
    resetDataPaths();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('posts to the provider /v1/audio/speech endpoint with text, model and default voice', async () => {
    await bus.call('tts.synthesize', { text: 'hello there' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9/v1/audio/speech');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'tts-1',
      input: 'hello there',
      voice: 'default-voice',
    });
  });

  it('writes the audio to <dataDir>/media/tts with the requested extension', async () => {
    const res = await bus.call<{ filePath: string; ext: string; bytes: number }>('tts.synthesize', { text: 'hi' });

    expect(res.ext).toBe('mp3');
    expect(res.bytes).toBe(4);
    expect(path.dirname(res.filePath)).toBe(path.join(tempDir, 'media', 'tts'));
    const onDisk = await fs.readFile(res.filePath);
    expect(onDisk.length).toBe(4);
    expect(getDataPaths().dataDir).toBe(tempDir);
  });

  it('honours a per-call voice and responseFormat override', async () => {
    const res = await bus.call<{ ext: string }>('tts.synthesize', { text: 'hi', voice: 'v2', responseFormat: 'wav' });
    expect(res.ext).toBe('wav');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.voice).toBe('v2');
    expect(body.response_format).toBe('wav');
  });

  it('throws a clear error when agent.media.tts is not configured', async () => {
    const badConfig = { ...testConfig, agent: { media: {} } } as unknown as AppConfig;
    const bus2 = new EmitterBus();
    bus2.beginLoading('config');
    bus2.register('config.get', { description: 'test', schema: z.object({}) }, () => badConfig);
    bus2.endLoading();
    const service2 = new TtsService();
    bus2.beginLoading('tts');
    await service2.init(bus2);
    bus2.endLoading();

    await expect(bus2.call('tts.synthesize', { text: 'hi' })).rejects.toThrow('agent.media.tts');
    service2.dispose();
    bus2.releaseService('tts');
  });
});
