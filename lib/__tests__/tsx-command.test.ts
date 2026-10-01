import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTsxCommand } from '../tsx-command.js';

describe('resolveTsxCommand', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), `tsx-command-${process.pid}-`));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeBin(name: string): void {
    const dir = join(root, 'node_modules', '.bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), '#!/bin/sh\n');
  }

  it('prefers the repo-local binary when it exists', () => {
    writeBin(process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
    expect(resolveTsxCommand(root)).toBe(join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx'));
  });

  it('falls back to bare `tsx` when node_modules/.bin is absent', () => {
    expect(resolveTsxCommand(root)).toBe('tsx');
  });

  it('falls back to bare `tsx` when node_modules/.bin exists but the binary is missing', () => {
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    expect(resolveTsxCommand(root)).toBe('tsx');
  });

  it('uses tsx.cmd on win32 and tsx elsewhere', () => {
    writeBin('tsx');
    writeBin('tsx.cmd');
    expect(resolveTsxCommand(root, 'win32')).toBe(join(root, 'node_modules', '.bin', 'tsx.cmd'));
    expect(resolveTsxCommand(root, 'linux')).toBe(join(root, 'node_modules', '.bin', 'tsx'));
    expect(resolveTsxCommand(root, 'darwin')).toBe(join(root, 'node_modules', '.bin', 'tsx'));
  });

  it('does not pick the wrong platform shim', () => {
    writeBin('tsx'); // only the POSIX shim exists
    // win32 needs tsx.cmd; a bare shim should not be used — fall back to PATH.
    expect(resolveTsxCommand(root, 'win32')).toBe('tsx');
    expect(resolveTsxCommand(root, 'linux')).toBe(join(root, 'node_modules', '.bin', 'tsx'));
  });
});
