/**
 * Locate the bundled pi CLI. The interactive entrypoints (`vargos chat`, `vargos config`)
 * spawn it directly; a global install falls back to `pi` on PATH.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

export function resolvePiCli(startDir: string): string {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return 'pi';
}
