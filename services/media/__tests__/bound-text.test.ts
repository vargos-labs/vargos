import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { boundForContext, DEFAULT_MAX_EXTRACT_CHARS } from '../bound-text.js';

describe('boundForContext', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `vargos-bound-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns text unchanged when within budget and writes nothing', async () => {
    const fullPath = path.join(tempDir, 'x.transcript.txt');
    const text = 'a'.repeat(50);

    const result = await boundForContext(text, fullPath, 100, 'transcript');

    expect(result).toBe(text);
    expect(existsSync(fullPath)).toBe(false);
  });

  it('returns the head and a pointer, and persists the full text when over budget', async () => {
    const fullPath = path.join(tempDir, 'x.transcript.txt');
    const text = 'b'.repeat(200);

    const result = await boundForContext(text, fullPath, 40, 'transcript');

    expect(result.startsWith('b'.repeat(40))).toBe(true);
    expect(result).toContain('truncated');
    expect(result).toContain(fullPath);
    expect(readFileSync(fullPath, 'utf-8')).toBe(text);
  });

  it('exposes a 100k-char default budget', () => {
    expect(DEFAULT_MAX_EXTRACT_CHARS).toBe(100_000);
  });
});
