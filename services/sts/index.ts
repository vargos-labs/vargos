/**
 * STS service — speech-to-speech device.
 *
 * Callable: sts.reply (internal — a device for call surfaces, not an agent tool:
 * the agent sits inside the chain, so exposing it as a tool would risk recursion)
 *
 * The composable unit a surface (WhatsApp Call today, phone call tomorrow) plugs
 * audio into: STT -> agent -> TTS. The surface owns the audio frames; STS owns the
 * understanding-and-speaking pipeline. Surfaces never call stt/tts/agent directly —
 * they call sts.reply, so the chain can change in one place.
 *
 * Duplex:
 *  - half (default): one sequential turn per call — listen, think, speak.
 *  - full: same chain, but the surface may start a new turn while one is in flight
 *    (barge-in). Full turn-taking (VAD/AEC) lives in the surface; STS stays stateless.
 */

import { z } from 'zod';
import type { Bus, Service } from '../../core/types.js';
import type { AppConfig } from '../../services/config/index.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('sts');

export const BOOT_PRIORITY = 30; // after stt/tts/agent — its calls are runtime, but keep boot order honest
export class StsService implements Service {
  readonly name = 'sts';
  private config!: AppConfig;
  private bus!: Bus;

  async init(bus: Bus): Promise<void> {
    this.bus = bus;
    this.config = await bus.call<AppConfig>('config.get', {});

    bus.register('sts.reply', {
      description: 'Speech-to-speech device: takes text or an audio file, runs it through the agent, and returns the spoken reply as an audio file. Half-duplex by default; full-duplex surfaces may overlap calls.',
      schema: z.object({
        input: z.object({
          text: z.string().optional().describe('Plain text input (skips STT).'),
          audioPath: z.string().optional().describe('Audio file to transcribe first.'),
        }).refine(v => (v.text ? 1 : 0) + (v.audioPath ? 1 : 0) === 1, { message: 'Provide exactly one of text or audioPath' }),
        sessionKey: z.string().optional().describe('Agent session to run the turn in (shares history with the surface, e.g. the caller\'s WhatsApp session).'),
        duplex: z.enum(['half', 'full']).optional().describe('Duplex mode override (defaults to agent.media.duplex, "half").'),
        model: z.string().optional().describe('Optional agent model override as "provider:modelId".'),
      }),
      internal: true,
    }, (p) => this.reply(p));

    log.debug('sts service initialized');
  }

  dispose(): void {}

  private async reply(params: {
    input: { text?: string; audioPath?: string };
    sessionKey?: string;
    duplex?: 'half' | 'full';
    model?: string;
  }): Promise<{ replyText: string; audioPath: string; duplex: 'half' | 'full'; timingMs: { stt: number; agent: number; tts: number } }> {
    const duplex = params.duplex ?? this.config.agent?.media?.duplex ?? 'half';
    const timing = { stt: 0, agent: 0, tts: 0 };

    // 1. STT — only when the surface handed us audio
    let text = params.input.text;
    if (!text && params.input.audioPath) {
      const t0 = Date.now();
      const { text: transcribed } = await this.bus.call<{ text: string }>('stt.transcribe', { filePath: params.input.audioPath });
      timing.stt = Date.now() - t0;
      text = transcribed;
    }
    if (!text) throw new Error('Empty input — nothing to speak');

    // 2. Agent — runs in the surface's session so call history is shared
    const t1 = Date.now();
    const { response } = await this.bus.call<{ response: string }>('agent.execute', {
      task: text,
      sessionKey: params.sessionKey,
      model: params.model,
    });
    timing.agent = Date.now() - t1;

    // 3. TTS
    const t2 = Date.now();
    const { filePath } = await this.bus.call<{ filePath: string }>('tts.synthesize', { text: response });
    timing.tts = Date.now() - t2;

    log.info(`sts.reply ok duplex=${duplex} stt=${timing.stt}ms agent=${timing.agent}ms tts=${timing.tts}ms`);
    return { replyText: response, audioPath: filePath, duplex, timingMs: timing };
  }
}

export function createService(): Service {
  return new StsService();
}
