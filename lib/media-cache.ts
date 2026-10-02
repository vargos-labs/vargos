import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('media-cache');

/**
 * File-based cache for media processing results.
 * Stores the cache in `{filePath}.metadata.json` next to the media file — survives restarts
 * and prevents duplicate API calls for the same file.
 *
 * Shared by the media and stt services.
 */
export interface MediaCacheEntry {
  transcribe?: string;
  describe?: string;
  [key: string]: string | undefined;
}

export class MediaCache {
  private processing = new Map<string, Promise<string>>();

  cachePath(filePath: string): string {
    return path.join(path.dirname(filePath), `${path.basename(filePath)}.metadata.json`);
  }

  private readCache(filePath: string): MediaCacheEntry | null {
    try {
      return JSON.parse(readFileSync(this.cachePath(filePath), 'utf-8')) as MediaCacheEntry;
    } catch {
      return null;
    }
  }

  private writeCache(filePath: string, entry: MediaCacheEntry): void {
    try {
      writeFileSync(this.cachePath(filePath), JSON.stringify(entry, null, 2), 'utf-8');
    } catch (err) {
      log.warn(`failed to write media cache for ${filePath}: ${err}`);
    }
  }

  async get<T extends keyof MediaCacheEntry>(
    filePath: string,
    type: T,
    fetcher: () => Promise<string>,
  ): Promise<string> {
    // Check file-based cache (cached forever)
    const cached = this.readCache(filePath);
    if (cached?.[type]) {
      return cached[type] as string;
    }

    // Dedup: if another caller is already processing this file, wait for them
    const existing = this.processing.get(filePath);
    if (existing) {
      log.debug(`media dedup: waiting for concurrent ${type} of ${filePath}`);
      return existing;
    }

    // Start processing
    const promise = fetcher().then(result => {
      // Update cache file (merge with existing entries)
      const existing = this.readCache(filePath) ?? {};
      this.writeCache(filePath, { ...existing, [type]: result });
      this.processing.delete(filePath);
      return result;
    }).catch(err => {
      this.processing.delete(filePath);
      throw err;
    });

    this.processing.set(filePath, promise);
    return promise;
  }
}
