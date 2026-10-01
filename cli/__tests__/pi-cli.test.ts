import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePiCli } from '../pi-cli.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolvePiCli', () => {
  it('finds the bundled pi CLI by walking up from a nested dir', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vargos-pi-cli-'));
    tmpDirs.push(root);
    const nested = path.join(root, 'cli');
    const dist = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist');
    mkdirSync(nested, { recursive: true });
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, 'cli.js'), '// pi');
    expect(resolvePiCli(nested)).toBe(path.join(dist, 'cli.js'));
  });

  it('falls back to `pi` on PATH when not found', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vargos-pi-cli-'));
    tmpDirs.push(root);
    expect(resolvePiCli(root)).toBe('pi');
  });
});
