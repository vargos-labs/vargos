import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDataPaths } from './paths.js';
import { copyFileResilient } from './util.js';

// Seeding is always copy-missing (user edits preserved). "Managed" templates are additionally
// offered for update by `vargos sync` when the bundled version changes — the user picks which to
// overwrite. Covers workspace/AGENTS.md and the bundled skills subtree (shipped code: each
// skill's SKILL.md + scripts). SOUL/TOOLS/MEMORY, personas, cron, and user-created skills (which
// aren't in .templates) are never offered. Paths are POSIX-relative to the data dir.
const OVERRIDABLE = new Set(['workspace/AGENTS.md']);
const OVERRIDABLE_PREFIXES = ['agent/skills/'];

/** Is this bundled template offered for update by `vargos sync`? */
function isManaged(rel: string): boolean {
  return OVERRIDABLE.has(rel) || OVERRIDABLE_PREFIXES.some(prefix => rel.startsWith(prefix));
}

/** Walk up from this module to locate `.templates/`. Works in both dev and dist layouts. */
export function findTemplatesRoot(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, '.templates');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

export interface TemplateFile {
  /** POSIX path relative to the data dir, e.g. 'workspace/AGENTS.md'. */
  rel: string;
  src: string;
  dest: string;
}

/** Recursively list every bundled template file. */
async function walkTemplates(srcDir: string, destDir: string, rel = ''): Promise<TemplateFile[]> {
  const out: TemplateFile[] = [];
  for (const entry of await fs.readdir(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await walkTemplates(src, dest, childRel));
    else out.push({ rel: childRel, src, dest });
  }
  return out;
}

/** True when dest exists and its bytes differ from the bundled source. */
async function differs(src: string, dest: string): Promise<boolean> {
  if (!existsSync(dest)) return false;
  const [a, b] = await Promise.all([fs.readFile(src), fs.readFile(dest)]);
  return !a.equals(b);
}

async function copy(file: TemplateFile): Promise<void> {
  await fs.mkdir(path.dirname(file.dest), { recursive: true });
  await copyFileResilient(file.src, file.dest);
}

/**
 * Seed the VARGOS data dir from `.templates/`. Copy-missing only — user edits are always
 * preserved. Updating a file that already exists is opt-in via `vargos sync`.
 */
export async function seedDataDir(
  logger: { info: (s: string) => void; warn: (s: string) => void },
): Promise<void> {
  const root = findTemplatesRoot();
  if (!root) {
    logger.warn('.templates not found — skipping seed');
    return;
  }
  for (const file of await walkTemplates(root, getDataPaths().dataDir)) {
    if (existsSync(file.dest)) continue;
    await copy(file);
    logger.info(`seeded ${file.dest}`);
  }
}

/**
 * Managed bundled templates that exist on disk but differ — candidates for `vargos sync`.
 * Scoped by isManaged() (AGENTS.md + skills), so user-owned files are never offered for overwrite.
 */
export async function collectTemplateConflicts(): Promise<TemplateFile[]> {
  const root = findTemplatesRoot();
  if (!root) return [];
  const conflicts: TemplateFile[] = [];
  for (const file of await walkTemplates(root, getDataPaths().dataDir)) {
    if (isManaged(file.rel) && await differs(file.src, file.dest)) conflicts.push(file);
  }
  return conflicts;
}

/** Overwrite the given dests from their bundled source (user confirms selection first). */
export async function overrideTemplates(files: TemplateFile[]): Promise<void> {
  for (const file of files) await copy(file);
}
