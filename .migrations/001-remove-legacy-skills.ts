/**
 * 001 — remove retired bundled skills left behind on existing installs.
 *
 * `.templates/agent/skills/` once shipped the `distill-*` skills (added in 5fa8158); they were
 * dropped from the bundle in 01f32b4. Seeding is copy-missing, and `vargos sync` only overwrites
 * files that still exist in the bundle — so a copy already on disk is never removed and lingers
 * forever. This deletes them once. Each is a personal-workflow skill that routes to a private
 * vault layout, so it must not survive in a general install.
 *
 * Deleting the whole skill directory is intentional here: these are retired assets, not
 * user-authored ones. Any other skill under `agent/skills/` is left untouched.
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { Migration } from '../lib/migrate.js';

/** Bundled skills that were later retired — never re-seeded, safe to delete everywhere. */
const LEGACY_SKILLS = ['distill-jsonl-conversation', 'distill-project'];

const migration: Migration = {
  id: '001-remove-legacy-skills',
  description: 'Remove retired bundled skills (distill-*) from the agent skills dir',
  async run({ paths, log }) {
    for (const name of LEGACY_SKILLS) {
      const dir = path.join(paths.agentDir, 'skills', name);
      if (!existsSync(dir)) continue;
      await rm(dir, { recursive: true, force: true });
      log.info(`removed retired skill ${name}`);
    }
  },
};

export default migration;
