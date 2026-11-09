/**
 * Run-once data migrations. Migration modules live in `.migrations/` (compiled to
 * `dist/.migrations/`), each a default-exported { id, description, run }. Applied ids
 * are tracked in `~/.vargos/.migrations.json`, so each runs exactly once — on boot
 * (automatic) or from the `vargos config` menu.
 *
 * To add one: drop `NNN-name.ts` into `.migrations/`. Order is filename order.
 */

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDataPaths, type DataPaths } from './paths.js';
import { permissionHint } from './error.js';

export interface MigrationContext {
  paths: DataPaths;
  log: { info(s: string): void; warn(s: string): void };
}

export interface Migration {
  /** Stable unique id (e.g. '001-drop-workspace-agents-md'). Recorded once applied. */
  id: string;
  description: string;
  run(ctx: MigrationContext): Promise<void>;
}

interface Ledger { applied: string[] }

/** Walk up to locate the `.migrations/` dir — repo root in dev, `dist/` in prod. */
function findMigrationsRoot(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, '.migrations');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

/** Load migration modules from a directory, sorted by filename. */
async function loadMigrations(root: string): Promise<Migration[]> {
  const files = (await fs.readdir(root))
    .filter(f => /^\d.*\.(js|ts)$/.test(f) && !f.endsWith('.d.ts'))
    .sort();

  const migrations: Migration[] = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(root, file)).href) as { default?: Migration };
    if (mod.default) migrations.push(mod.default);
  }
  return migrations;
}

/**
 * Apply pending migrations in order, recording each id on success. Stops on the first
 * failure so ordering is preserved (the failed one retries next run). Pure core — the
 * ledger file and migration list are injected, so it's directly testable.
 */
export async function applyMigrations(
  migrations: Migration[],
  ledgerFile: string,
  ctx: MigrationContext,
  opts: { dryRun?: boolean } = {},
): Promise<{ applied: string[]; pending: string[] }> {
  const ledger: Ledger = await fs.readFile(ledgerFile, 'utf-8')
    .then(c => JSON.parse(c) as Ledger)
    .catch(() => ({ applied: [] }));
  const done = new Set(ledger.applied);

  const pending = migrations.filter(m => !done.has(m.id));
  const justApplied: string[] = [];

  for (const m of pending) {
    if (opts.dryRun) {
      ctx.log.info(`[dry-run] would run ${m.id}: ${m.description}`);
      continue;
    }
    try {
      ctx.log.info(`running migration ${m.id}: ${m.description}`);
      await m.run(ctx);
      done.add(m.id);
      await fs.mkdir(path.dirname(ledgerFile), { recursive: true });
      await fs.writeFile(ledgerFile, JSON.stringify({ applied: [...done] }, null, 2));
      justApplied.push(m.id);
      ctx.log.info(`✅ migration ${m.id} applied`);
    } catch (err) {
      const reason = permissionHint(err, ctx.paths.dataDir) ?? (err instanceof Error ? err.message : String(err));
      ctx.log.warn(`migration ${m.id} failed (retries next run): ${reason}`);
      break;
    }
  }

  return { applied: justApplied, pending: pending.map(m => m.id) };
}

/** Discover and run all pending migrations. Safe to call on every boot. */
export async function runMigrations(
  log: MigrationContext['log'],
  opts: { dryRun?: boolean } = {},
): Promise<void> {
  const root = findMigrationsRoot();
  if (!root) return;

  const paths = getDataPaths();
  const ledgerFile = path.join(paths.dataDir, '.migrations.json');
  const migrations = await loadMigrations(root);
  await applyMigrations(migrations, ledgerFile, { paths, log }, opts);
}

/** Ids of migrations not yet in the ledger — cheap check for the first-run journey. */
export async function pendingMigrations(): Promise<string[]> {
  const root = findMigrationsRoot();
  if (!root) return [];

  const ledgerFile = path.join(getDataPaths().dataDir, '.migrations.json');
  const ledger: Ledger = await fs.readFile(ledgerFile, 'utf-8')
    .then(c => JSON.parse(c) as Ledger)
    .catch(() => ({ applied: [] }));
  const done = new Set(ledger.applied);

  return (await loadMigrations(root)).filter(m => !done.has(m.id)).map(m => m.id);
}
