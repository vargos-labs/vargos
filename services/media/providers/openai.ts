import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WHISPER_EXTS, MIME_TO_AUDIO_EXT, getMimeTypeFromExt } from '../../../lib/mime.js';
import { validateHttpResponse } from '../../../lib/http-validate.js';
import type { MediaProvider } from './provider.js';

/** Normalize an OpenAI-compatible base URL by stripping a trailing /v1 (we append it per-endpoint). */
function normalizeApiBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? 'https://api.openai.com').replace(/\/v1\/?$/, '');
}

export class OpenAIProvider implements MediaProvider {
  async transcribeAudio(filePath: string, model: string, apiKey: string, baseUrl?: string): Promise<string> {
    const buffer = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const fixedExt = WHISPER_EXTS.has(ext) ? ext : (MIME_TO_AUDIO_EXT[ext] || '.ogg');
    const fileName = path.basename(filePath).replace(/\.[^.]+$/, fixedExt) || `audio${fixedExt}`;

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)], { type: 'audio/mpeg' }), fileName);
    form.append('model', model || 'whisper-1');

    const res = await fetch(`${normalizeApiBaseUrl(baseUrl)}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    validateHttpResponse(res, 'Whisper API');
    const data = (await res.json()) as { text: string };
    return data.text || '[No speech detected]';
  }

  async describeImage(filePath: string, model: string, apiKey: string, baseUrl?: string): Promise<string> {
    const buffer = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = getMimeTypeFromExt(ext);
    const imageData = buffer.toString('base64');

    const res = await fetch(`${normalizeApiBaseUrl(baseUrl)}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image concisely.' },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageData}` } },
          ],
        }],
      }),
    });

    validateHttpResponse(res, 'OpenAI Vision');
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content ?? '';
  }

  async synthesizeSpeech(params: {
    text: string;
    model: string;
    apiKey: string;
    voice?: string;
    responseFormat?: string;
    baseUrl?: string;
  }): Promise<Buffer> {
    const body: Record<string, unknown> = {
      model: params.model || 'tts-1',
      input: params.text,
    };
    if (params.voice) body.voice = params.voice;
    if (params.responseFormat) body.response_format = params.responseFormat;

    const res = await fetch(`${normalizeApiBaseUrl(params.baseUrl)}/v1/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${params.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    validateHttpResponse(res, 'Speech synthesis API');
    return Buffer.from(await res.arrayBuffer());
  }
}
