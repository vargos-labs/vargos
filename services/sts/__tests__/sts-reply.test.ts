/**
 * Unit tests for the STS device (sts.reply).
 * Stubs the stt/agent/tts bus methods the device chains and verifies the
 * pipeline order, session passthrough, duplex defaulting and input validation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { EmitterBus } from '../../../core/bus.js';
import { StsService } from '../index.js';
import type { AppConfig } from '../../config/index.js';

function makeBus(config: unknown): EmitterBus {
  const bus = new EmitterBus();
  bus.beginLoading('config');
  bus.register('config.get', { description: 'test', schema: z.object({}) }, () => config);
  bus.endLoading();
  return bus;
}

describe('sts.reply', () => {
  let bus: EmitterBus;
  let service: StsService;
  let sttStub: ReturnType<typeof vi.fn>;
  let agentStub: ReturnType<typeof vi.fn>;
  let ttsStub: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    sttStub = vi.fn(async () => ({ text: 'transcribed input' }));
    agentStub = vi.fn(async () => ({ response: 'agent reply text' }));
    ttsStub = vi.fn(async () => ({ filePath: '/tmp/out.mp3' }));

    bus = makeBus({ agent: { media: {} } } satisfies Partial<AppConfig>);
    bus.beginLoading('stubs');
    bus.register('stt.transcribe', { description: 'stub', schema: z.object({ filePath: z.string() }) }, sttStub);
    bus.register('agent.execute', { description: 'stub', schema: z.object({}).passthrough() }, agentStub);
    bus.register('tts.synthesize', { description: 'stub', schema: z.object({ text: z.string() }).passthrough() }, ttsStub);
    bus.endLoading();

    service = new StsService();
    bus.beginLoading('sts');
    await service.init(bus);
    bus.endLoading();
  });

  afterEach(() => {
    service.dispose();
    bus.releaseService('sts');
    bus.releaseService('stubs');
  });

  it('chains text input: agent -> tts (no stt), returning reply text and audio path', async () => {
    const res = await bus.call<{ replyText: string; audioPath: string }>('sts.reply', {
      input: { text: 'hi' },
      sessionKey: 'whatsapp:test:1',
    });

    expect(sttStub).not.toHaveBeenCalled();
    expect(agentStub).toHaveBeenCalledWith(expect.objectContaining({
      task: 'hi',
      sessionKey: 'whatsapp:test:1',
    }));
    expect(ttsStub).toHaveBeenCalledWith({ text: 'agent reply text' });
    expect(res.replyText).toBe('agent reply text');
    expect(res.audioPath).toBe('/tmp/out.mp3');
  });

  it('chains audio input: stt -> agent -> tts', async () => {
    await bus.call('sts.reply', { input: { audioPath: '/tmp/in.ogg' } });

    expect(sttStub).toHaveBeenCalledWith({ filePath: '/tmp/in.ogg' });
    expect(agentStub).toHaveBeenCalledWith(expect.objectContaining({ task: 'transcribed input' }));
    expect(ttsStub).toHaveBeenCalled();
    expect(sttStub.mock.invocationCallOrder[0]).toBeLessThan(agentStub.mock.invocationCallOrder[0]);
    expect(agentStub.mock.invocationCallOrder[0]).toBeLessThan(ttsStub.mock.invocationCallOrder[0]);
  });

  it('defaults duplex to half and honours an override', async () => {
    const half = await bus.call<{ duplex: string }>('sts.reply', { input: { text: 'a' } });
    expect(half.duplex).toBe('half');

    const full = await bus.call<{ duplex: string }>('sts.reply', { input: { text: 'a' }, duplex: 'full' });
    expect(full.duplex).toBe('full');
  });

  it('reads the duplex default from agent.media.duplex', async () => {
    const bus2 = makeBus({ agent: { media: { duplex: 'full' } } } satisfies Partial<AppConfig>);
    bus2.beginLoading('stubs');
    bus2.register('stt.transcribe', { description: 'stub', schema: z.object({ filePath: z.string() }) }, sttStub);
    bus2.register('agent.execute', { description: 'stub', schema: z.object({}).passthrough() }, agentStub);
    bus2.register('tts.synthesize', { description: 'stub', schema: z.object({ text: z.string() }).passthrough() }, ttsStub);
    bus2.endLoading();
    const service2 = new StsService();
    bus2.beginLoading('sts');
    await service2.init(bus2);
    bus2.endLoading();

    const res = await bus2.call<{ duplex: string }>('sts.reply', { input: { text: 'a' } });
    expect(res.duplex).toBe('full');
    service2.dispose();
    bus2.releaseService('sts');
    bus2.releaseService('stubs');
  });

  it('rejects input with both text and audioPath, and empty input', async () => {
    await expect(bus.call('sts.reply', { input: { text: 'a', audioPath: '/x.ogg' } }))
      .rejects.toThrow('Provide exactly one of text or audioPath');
  });
});
