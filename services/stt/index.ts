/**
 * STT service — speech-to-text device.
 *
 * Callable: stt.transcribe
 *
 * The canonical speech-to-text unit: a surface (e.g. a call host) hands it an audio
 * file and gets raw text back. Distinct from media.transcribeAudio, which is the
 * agent-facing tool that additionally bounds the text for context injection.
 * Both share the file cache and provider resolution.
 */

import { z } from 'zod';
import type { Bus, Service } from '../../core/types.js';
import type { AppConfig } from '../../services/config/index.js';
import { createLogger } from '../../lib/logger.js';
import { createProvider } from '../media/providers/index.js';
import { OpenAIProvider } from '../media/providers/openai.js';
import type { MediaProvider } from '../media/providers/provider.js';
import { MediaCache } from '../../lib/media-cache.js';
import { resolveModelRef } from '../media/providers/provider-ref.js';

const log = createLogger('stt');

export const BOOT_PRIORITY = 20;
export class SttService implements Service {
  readonly name = 'stt';
  private cache = new MediaCache();
  private config!: AppConfig;

  async init(bus: Bus): Promise<void> {
    this.config = await bus.call<AppConfig>('config.get', {});

    bus.register('stt.transcribe', {
      description: 'Transcribe an audio file to raw text (speech-to-text device). Results are cached next to the file.',
      schema: z.object({ filePath: z.string() }),
      cli: { positional: ['filePath'] },
    }, (p) => this.transcribe(p));

    log.debug('stt service initialized');
  }

  dispose(): void {}

  /** Same fallback as the media service: unknown provider names use the
   *  OpenAI-compatible implementation (self-hosted Whisper/ASR servers). */
  private provider(name: string): MediaProvider {
    try {
      return createProvider(name);
    } catch {
      return new OpenAIProvider();
    }
  }

  private async transcribe(params: { filePath: string }): Promise<{ text: string; model: string; elapsedMs: number }> {
    const audioRef = this.config.agent?.media?.audio;
    if (!audioRef) throw new Error('No STT model configured (agent.media.audio)');

    const { provider: name, model, apiKey, baseUrl } = resolveModelRef(this.config, audioRef);
    const started = Date.now();
    const text = await this.cache.get(params.filePath, 'transcribe', () =>
      this.provider(name).transcribeAudio(params.filePath, model, apiKey, baseUrl),
    );
    return { text, model: `${name}:${model}`, elapsedMs: Date.now() - started };
  }
}

export function createService(): Service {
  return new SttService();
}
