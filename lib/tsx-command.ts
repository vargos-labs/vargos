/**
 * Resolve the `tsx` command used by the dev supervisor to spawn `boot.ts`.
 *
 * Prefer the repo-local binary because the caller's PATH may not include
 * `node_modules/.bin` (systemd units ship a minimal PATH), which makes a bare
 * `tsx` spawn fail with ENOENT. Fall back to bare `tsx` so unusual layouts
 * still work: hoisted/pnpm stores, an `npx tsx` cache, or a global install.
 * On Windows the local shim is `tsx.cmd`, not `tsx`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function resolveTsxCommand(
  repoRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const binary = platform === 'win32' ? 'tsx.cmd' : 'tsx';
  const local = join(repoRoot, 'node_modules', '.bin', binary);
  return existsSync(local) ? local : 'tsx';
}
