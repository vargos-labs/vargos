/**
 * Integration coverage for the retained media.transcribeAudio tool.
 * Stubs the OpenAI-compatible /v1/audio/transcriptions endpoint via global fetch
 * and verifies transcription output plus the shared file cache.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { EmitterBus } from '../../../core/bus.js';
import { MediaService } from '../index.js';
import type { AppConfig } from '../../config/index.js';

const testConfig = {
  agent: { media: { audio: 'openai:whisper-1' } },
  auth: { openai: { type: 'api_key', key: 'sk-test' } },
  providers: { openai: { baseUrl: 'http://127.0.0.1:9/v1' } },
} as unknown as AppConfig;

describe('media.transcribeAudio', () => {
  let tempDir: string;
  let mediaFile: string;
  let bus: EmitterBus;
  let service: MediaService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `media-transcribe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
    mediaFile = path.join(tempDir, 'note.ogg');
    await fs.writeFile(mediaFile, 'fake-audio');

    fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ text: 'hello world' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    bus = new EmitterBus();
    bus.beginLoading('config');
    bus.register('config.get', { description: 'test', schema: z.object({}) }, () => testConfig);
    bus.endLoading();

    service = new MediaService();
    bus.beginLoading('media');
    await service.init(bus);
    bus.endLoading();
  });

  afterEach(async () => {
    service.dispose();
    bus.releaseService('media');
    vi.unstubAllGlobals();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('transcribes audio through the configured provider', async () => {
    const res = await bus.call<{ text: string }>('media.transcribeAudio', { filePath: mediaFile });
    expect(res.text).toBe('hello world');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:9/v1/audio/transcriptions');
  });

  it('writes the shared cache file next to the media and skips the API on the second call', async () => {
    await bus.call('media.transcribeAudio', { filePath: mediaFile });
    const cacheFile = path.join(tempDir, 'note.ogg.metadata.json');
    expect((await fs.readFile(cacheFile, 'utf-8')).includes('hello world')).toBe(true);

    await bus.call('media.transcribeAudio', { filePath: mediaFile });
    expect(fetchMock).toHaveBeenCalledOnce(); // cache hit — no second API call
  });

  it('throws a clear error when agent.media.audio is not configured', async () => {
    const badConfig = { ...testConfig, agent: { media: {} } } as unknown as AppConfig;
    const bus2 = new EmitterBus();
    bus2.beginLoading('config');
    bus2.register('config.get', { description: 'test', schema: z.object({}) }, () => badConfig);
    bus2.endLoading();
    const service2 = new MediaService();
    bus2.beginLoading('media');
    await service2.init(bus2);
    bus2.endLoading();

    await expect(bus2.call('media.transcribeAudio', { filePath: mediaFile })).rejects.toThrow('agent.media.audio');
    service2.dispose();
    bus2.releaseService('media');
  });
});
