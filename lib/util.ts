/** Small generic utilities. */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Read+parse a JSON file; returns `undefined` if it's missing or unparseable. */
export function readJson<T = unknown>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Write pretty JSON, creating parent dirs. Defaults to owner-only (0600) perms. */
export function writeJson(file: string, data: unknown, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), { mode });
}

/** Short unique ID: `prefix-timestamp-random`. */
export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Race a promise against a timeout; rejects if it doesn't settle in time. */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message?: string): Promise<T> {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(message ?? `Timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]);
}

/** Head/tail truncation (70% head, 20% tail) for large text. */
export function truncate(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const head = Math.floor(maxChars * 0.7);
  const tail = Math.floor(maxChars * 0.2);
  return `${content.slice(0, head)}\n\n[...truncated...]\n\n${content.slice(-tail)}`;
}

/** Interruptible sleep: resolves after `ms`, or rejects with AbortError if `signal` aborts. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> => delay(ms, undefined, { signal });

/** Strip markdown to readable plain text (for WhatsApp/Telegram). */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*{1,3}|_{1,3})(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/```[\w]*\n?([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/^[\t ]*[-*+]\s+/gm, '• ')
    .replace(/^>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Errno values from a copy_file_range(2)-backed copy that a plain read+write can recover from. */
const COPYFILE_FALLBACK_CODES = new Set([
  'EXDEV', // cross-device link — the destination is on a different filesystem
  'EACCES',
  'EPERM', // surface from close(2) on the destination even when the write succeeded
  'EOPNOTSUPP',
  'ENOTSUP',
  'EINVAL', // filesystem does not implement the operation
]);

/**
 * Copy a file, falling back to read+write when a direct copy cannot cross filesystems.
 *
 * `fs.copyFile` is backed by copy_file_range(2). When src and dest live on different filesystems —
 * a local disk into an NFS-backed data dir, for instance one bind-mounted into an LXC — that
 * syscall fails with EXDEV, and the kernel's own fallback can then report EACCES/EPERM from
 * close(2) on a destination that is plainly writable. Seeding a fresh `~/.vargos` is exactly that
 * case, and it made `vargos start` die on the first template. A read+write always works there, so
 * retry with it. Errors that do not look like that failure propagate untouched.
 */
export async function copyFileResilient(src: string, dest: string): Promise<void> {
  try {
    await copyFile(src, dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!code || !COPYFILE_FALLBACK_CODES.has(code)) throw err;
    await writeFile(dest, await readFile(src));
  }
}
