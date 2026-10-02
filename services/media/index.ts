/**
 * Media service — audio transcription, image description, and document extraction
 *
 * Callable: media.transcribeAudio, media.describeImage, media.extractDocument
 */

import { z } from 'zod';
import type { Bus, Service } from '../../core/types.js';
import type { AppConfig } from '../../services/config/index.js';
import { createLogger } from '../../lib/logger.js';
import { createProvider } from './providers/index.js';
import { OpenAIProvider } from './providers/openai.js';
import type { MediaProvider } from './providers/provider.js';
import { extractDocument } from './providers/document.js';
import { boundForContext, DEFAULT_MAX_EXTRACT_CHARS } from './bound-text.js';
import { MediaCache } from '../../lib/media-cache.js';
import { resolveModelRef } from './providers/provider-ref.js';

const log = createLogger('media');

export const BOOT_PRIORITY = 20; // media processing tools before agent runs
export class MediaService implements Service {
  readonly name = 'media';
  private cache = new MediaCache();
  private config!: AppConfig;

  async init(bus: Bus): Promise<void> {
    this.config = await bus.call<AppConfig>('config.get', {});

    bus.register('media.transcribeAudio', {
      description: 'Transcribe an audio file to text using configured audio model. Results are cached.',
      schema: z.object({ filePath: z.string() }),
      cli: { positional: ['filePath'] },
    }, (p) => this.transcribeAudio(p));

    bus.register('media.describeImage', {
      description: 'Describe an image using configured vision model. Results are cached.',
      schema: z.object({ filePath: z.string() }),
      cli: { positional: ['filePath'] },
    }, (p) => this.describeImage(p));

    bus.register('media.extractDocument', {
      description: 'Extract text from documents (PDF, DOCX, XLSX, TXT, MD).',
      schema: z.object({ filePath: z.string(), mimeType: z.string() }),
      cli: { positional: ['filePath', 'mimeType'] },
    }, (p) => extractDocument(p.filePath, p.mimeType, { maxChars: this.maxExtractChars() }));

    log.debug('media service initialized');
  }

  dispose(): void {}

  /** Context budget for media text (documents, transcripts); see bound-text.ts. */
  private maxExtractChars(): number {
    return this.config.agent?.media?.maxExtractChars ?? DEFAULT_MAX_EXTRACT_CHARS;
  }

  /** Custom provider names (self-hosted OpenAI-compatible endpoints, e.g. a local
   *  Whisper server) fall back to the OpenAI implementation — the caller already
   *  resolved an auth key + baseUrl for the provider from config. */
  private mediaProvider(name: string): MediaProvider {
    try {
      return createProvider(name);
    } catch {
      return new OpenAIProvider();
    }
  }

  private async transcribeAudio(params: { filePath: string }): Promise<{ text: string }> {
    const audioRef = this.config.agent?.media?.audio;
    if (!audioRef) throw new Error('No audio model configured (agent.media.audio)');

    const { provider, model, apiKey, baseUrl } = resolveModelRef(this.config, audioRef);
    const text = await this.cache.get(params.filePath, 'transcribe', () =>
      this.mediaProvider(provider).transcribeAudio(params.filePath, model, apiKey, baseUrl),
    );
    const bounded = await boundForContext(text, `${params.filePath}.transcript.txt`, this.maxExtractChars(), 'transcript');
    return { text: bounded };
  }

  private async describeImage(params: { filePath: string }): Promise<{ description: string }> {
    const imgRef = this.config.agent?.media?.image;
    if (!imgRef) throw new Error('No image model configured (agent.media.image)');

    const { provider, model, apiKey, baseUrl } = resolveModelRef(this.config, imgRef);
    const description = await this.cache.get(params.filePath, 'describe', () =>
      this.mediaProvider(provider).describeImage(params.filePath, model, apiKey, baseUrl),
    );
    return { description };
  }

}

export function createService(): Service {
  return new MediaService();
}
