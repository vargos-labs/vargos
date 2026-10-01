#!/usr/bin/env node
/**
 * Simulate `npx @vargos-labs/vargos <args>` using the *locally built* package.
 *
 * Why: `pnpm run build` produces dist/, but that never exercises what a real user
 * gets. npx installs the published tarball into a fresh, isolated dependency tree
 * and runs the `vargos` bin from there. This script does the same, but packs the
 * working tree instead of fetching from npm:
 *
 *   1. `pnpm pack`  — builds via the `prepare` script and writes the tarball
 *      (respects package.json `files`, so missing-file bugs surface here).
 *   2. fresh `npm install <tarball>` into a throwaway prefix — a clean dependency
 *      tree, exactly like npx, so undeclared/dep-gaps surface.
 *   3. runs the installed `vargos` bin with your args.
 *
 * Every run installs into a new temp dir, so a rebuilt tarball is never masked by
 * npx's version-keyed cache.
 *
 * Usage:
 *   pnpm npx:local -- --version
 *   pnpm npx:local -- start
 *   VARGOS_DATA_DIR=/tmp/vargos-try pnpm npx:local -- config show
 *   VARGOS_NPX_TMP=/tmp/vargos-npx pnpm npx:local -- --help   # inspect the install
 *
 * Env:
 *   VARGOS_NPX_TMP  fixed staging dir (kept for inspection). Default: fresh temp dir.
 *   SKIP_BUILD=1    reuse an existing tarball in the staging dir instead of packing.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = !!process.env.VARGOS_NPX_TMP;
const stage = keep ? path.resolve(process.env.VARGOS_NPX_TMP) : mkdtempSync(path.join(tmpdir(), 'vargos-npx-'));
mkdirSync(stage, { recursive: true });
const prefix = path.join(stage, 'install');
const args = process.argv.slice(2);
// `pnpm npx:local -- <args>` forwards the `--` separator to us; drop a leading one.
if (args[0] === '--') args.shift();

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: root, ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) process.exit(res.status ?? 1);
}

function findTarball() {
  const tgz = readdirSync(stage).filter((f) => f.endsWith('.tgz'));
  if (tgz.length === 0) throw new Error(`no .tgz found in ${stage}`);
  return path.join(stage, tgz.sort().at(-1));
}

try {
  let tarball;
  if (process.env.SKIP_BUILD === '1' && existsSync(stage)) {
    tarball = findTarball();
    console.error(`[npx:local] reusing ${path.basename(tarball)} (SKIP_BUILD=1)`);
  } else {
    console.error('[npx:local] packing (this runs `prepare` → build)…');
    run('pnpm', ['pack', '--pack-destination', stage]);
    tarball = findTarball();
  }

  console.error(`[npx:local] installing ${path.basename(tarball)} into a fresh prefix…`);
  run('npm', ['install', '--prefix', prefix, '--no-save', '--no-audit', '--no-fund', '--loglevel=error', tarball]);

  const bin = path.join(prefix, 'node_modules', '.bin', 'vargos');
  if (!existsSync(bin)) throw new Error(`vargos bin not found at ${bin}`);

  run(bin, args, { cwd: process.cwd() });
} finally {
  if (!keep) rmSync(stage, { recursive: true, force: true });
  else console.error(`[npx:local] kept staging dir: ${stage}`);
}
