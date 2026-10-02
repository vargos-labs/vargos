/**
 * TTS service — text-to-speech device.
 *
 * Callable: tts.synthesize
 *
 * The canonical text-to-speech unit: a surface hands it text and gets an audio
 * file back. Any OpenAI-compatible /v1/audio/speech endpoint works (self-hosted
 * VoiceStudio, OpenAI, LM Studio, ...). Output files land in <dataDir>/media/tts/.
 */

import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Bus, Service } from '../../core/types.js';
import type { AppConfig } from '../../services/config/index.js';
import { createLogger } from '../../lib/logger.js';
import { createProvider } from '../media/providers/index.js';
import { OpenAIProvider } from '../media/providers/openai.js';
import type { MediaProvider } from '../media/providers/provider.js';
import { resolveModelRef } from '../media/providers/provider-ref.js';
import { getDataPaths } from '../../lib/paths.js';

const log = createLogger('tts');

export const BOOT_PRIORITY = 20;
export class TtsService implements Service {
  readonly name = 'tts';
  private config!: AppConfig;

  async init(bus: Bus): Promise<void> {
    this.config = await bus.call<AppConfig>('config.get', {});

    bus.register('tts.synthesize', {
      description: 'Synthesize speech from text using the configured TTS model. Returns the path to the generated audio file.',
      schema: z.object({
        text: z.string().min(1).describe('Text to speak.'),
        voice: z.string().optional().describe('Voice override (defaults to agent.media.voice).'),
        responseFormat: z.enum(['mp3', 'ogg', 'opus', 'wav', 'aac', 'flac']).optional().describe('Output format (defaults to provider default, usually mp3).'),
      }),
      cli: { positional: ['text'] },
    }, (p) => this.synthesize(p));

    log.debug('tts service initialized');
  }

  dispose(): void {}

  /** Same fallback as the media service: unknown provider names use the
   *  OpenAI-compatible implementation (self-hosted TTS servers). */
  private provider(name: string): MediaProvider {
    try {
      return createProvider(name);
    } catch {
      return new OpenAIProvider();
    }
  }

  private async synthesize(params: {
    text: string;
    voice?: string;
    responseFormat?: string;
  }): Promise<{ filePath: string; ext: string; model: string; voice?: string; bytes: number; elapsedMs: number }> {
    const ttsRef = this.config.agent?.media?.tts;
    if (!ttsRef) throw new Error('No TTS model configured (agent.media.tts)');

    const { provider: name, model, apiKey, baseUrl } = resolveModelRef(this.config, ttsRef);
    const voice = params.voice ?? this.config.agent?.media?.voice;

    const started = Date.now();
    const audio = await this.provider(name).synthesizeSpeech({
      text: params.text,
      model,
      apiKey,
      voice,
      responseFormat: params.responseFormat,
      baseUrl,
    });

    const ext = params.responseFormat ?? 'mp3';
    const outDir = path.join(getDataPaths().dataDir, 'media', 'tts');
    mkdirSync(outDir, { recursive: true });
    const filePath = path.join(outDir, `tts-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`);
    writeFileSync(filePath, audio);

    return {
      filePath,
      ext,
      model: `${name}:${model}`,
      voice,
      bytes: audio.length,
      elapsedMs: Date.now() - started,
    };
  }
}

export function createService(): Service {
  return new TtsService();
}
