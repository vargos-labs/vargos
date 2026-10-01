import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MigrationContext } from '../../lib/migrate.js';
import type { DataPaths } from '../../lib/paths.js';
import migration from '../001-remove-legacy-skills.js';

const tmpDirs: string[] = [];

function agentDirWith(skills: string[]): string {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'vargos-migration-'));
  tmpDirs.push(dataDir);
  for (const name of skills) {
    const dir = path.join(dataDir, 'agent', 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), `# ${name}\n`);
  }
  return path.join(dataDir, 'agent');
}

function ctx(agentDir: string): MigrationContext {
  return { paths: { agentDir } as DataPaths, log: { info: () => {}, warn: () => {} } };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('migration 001 — remove legacy skills', () => {
  it('deletes the retired distill-* skills and keeps user skills', async () => {
    const agentDir = agentDirWith(['distill-jsonl-conversation', 'distill-project', 'my-custom']);
    await migration.run(ctx(agentDir));

    expect(existsSync(path.join(agentDir, 'skills', 'distill-jsonl-conversation'))).toBe(false);
    expect(existsSync(path.join(agentDir, 'skills', 'distill-project'))).toBe(false);
    expect(existsSync(path.join(agentDir, 'skills', 'my-custom', 'SKILL.md'))).toBe(true);
  });

  it('is a no-op when the retired skills are absent', async () => {
    const agentDir = agentDirWith(['skill-creator']);
    await expect(migration.run(ctx(agentDir))).resolves.toBeUndefined();
    expect(existsSync(path.join(agentDir, 'skills', 'skill-creator'))).toBe(true);
  });

  it('is idempotent', async () => {
    const agentDir = agentDirWith(['distill-project']);
    await migration.run(ctx(agentDir));
    await expect(migration.run(ctx(agentDir))).resolves.toBeUndefined();
  });
});
