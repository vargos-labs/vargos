/**
 * Guard for the bundled skill library: every `.templates/agent/skills/<dir>/SKILL.md` must have
 * frontmatter that parses and carries a usable `name` + `description`.
 *
 * Two YAML traps motivated this:
 *   - a plain (unquoted) scalar containing `": "` makes `yaml` throw "Nested mappings are not
 *     allowed in compact mappings", which Pi surfaces as a *skill conflict* and the skill is
 *     dropped (this is what broke `nextjs-anti-patterns` / `test-driven-development`);
 *   - a plain scalar containing `" #"` parses fine but is silently truncated to a comment.
 * Block scalars (`|`, `>`, `>-`) are the intended way to write multi-line text, so they are
 * exempt from the round-trip check.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../frontmatter.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skillsDir = path.join(repoRoot, '.templates', 'agent', 'skills');

const skillNames = readdirSync(skillsDir).filter((name) => existsSync(path.join(skillsDir, name, 'SKILL.md')));

describe('bundled skill frontmatter', () => {
  it('ships a non-empty skill library', () => {
    expect(skillNames.length).toBeGreaterThan(0);
  });

  it.each(skillNames)('%s parses with a name and description', (name) => {
    const content = readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf-8');
    const parsed = parseFrontmatter<{ name?: unknown; description?: unknown }>(content);

    expect(parsed, `${name}: frontmatter must be valid YAML`).not.toBeNull();
    expect(typeof parsed!.meta.name, `${name}: "name" must be a string`).toBe('string');
    expect(parsed!.meta.name, `${name}: "name" must not be empty`).toBeTruthy();
    expect(typeof parsed!.meta.description, `${name}: "description" must be a string`).toBe('string');
    expect(parsed!.meta.description, `${name}: "description" must not be empty`).toBeTruthy();

    const raw = /^description: (.*)$/m.exec(content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '')?.[1];
    if (raw && !/^[|>]/.test(raw)) {
      expect(parsed!.meta.description, `${name}: plain description must not be truncated`).toBe(raw);
    }
  });
});
