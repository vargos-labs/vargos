/**
 * `vargos setup` — the one folded command.
 *
 * Seeds the data dir, applies pending migrations, configures an LLM provider if
 * one isn't usable yet, checks external prerequisites, and (on a fresh install)
 * offers channels + MCP. Idempotent: safe to re-run any time.
 *
 * Triggers:
 *   - `vargos setup`            explicit, always runs the full pass
 *   - `vargos` / `npx …`        bare invocation, only when !isReady()
 *   - `vargos start`            only when !isReady() (fresh / empty config)
 *
 * `vargos start` on an already-configured install never comes through here — it
 * boots straight away (boot.ts still seeds + migrates silently on every boot).
 *
 * Non-interactive callers (no TTY: systemd, docker) get a one-line actionable
 * error and a non-zero exit instead of a hanging prompt.
 */

import { existsSync } from 'node:fs';
import * as p from '@clack/prompts';
import { getDataPaths } from '../lib/paths.js';
import { seedDataDir } from '../lib/templates.js';
import { runMigrations, pendingMigrations } from '../lib/migrate.js';
import { reportProblems, runDoctors } from '../scripts/doctors/index.js';
import { providerReady, configureProvider, configureFromEnv } from './provider.js';
import { offerEnrichment } from './enrich.js';

const quiet = { info: () => {}, warn: (s: string) => console.warn(s) };

/** Cheap, side-effect free: can the daemon boot and serve a working agent? */
export function isReady(): boolean {
  return existsSync(getDataPaths().configFile) && providerReady();
}

export interface SetupOpts {
  /** false → never prompt; print guidance and exit non-zero if not ready. */
  interactive?: boolean;
  /** The caller boots the daemon right after (`vargos start`) — don't tell the user to. */
  booting?: boolean;
}

/**
 * Run the folded setup pass. Returns normally once the install is ready; exits
 * the process on user cancel or (non-interactive) on an unmet requirement.
 */
/**
 * The command that boots the daemon, as this user can type it: `vargos` is only on PATH
 * for a global install — an npx run or a clone needs its own spelling.
 */
export function startCommand(): string {
  if (process.env.npm_command === 'exec') return 'npx @vargos-labs/vargos start';
  if (process.env.npm_lifecycle_event) return 'pnpm start';
  return 'vargos start';
}

export async function runSetup({ interactive = true, booting = false }: SetupOpts = {}): Promise<void> {
  // "First run" = no working provider yet. Not "no config.json": seeding writes that, so a
  // wizard cancelled halfway would otherwise skip the channel offer forever.
  const fresh = !providerReady();

  // ── Auto steps — no prompt, no header ──────────────────────────────────────
  await seedDataDir(quiet);
  if ((await pendingMigrations()).length) await runMigrations(quiet);

  // ── Required: a usable LLM provider ────────────────────────────────────────
  if (!providerReady()) {
    if (!interactive) {
      // Headless (docker, systemd): a provider key in the environment is enough.
      const failure = await configureFromEnv();
      if (failure === undefined) {
        console.error(
          '\n  ⚡ Vargos is not configured.\n' +
          '  Run "vargos setup" in a terminal to choose a provider and enter your API key,\n' +
          '  or set a provider key in the environment (e.g. ANTHROPIC_API_KEY).\n',
        );
        process.exit(1);
      }
      if (failure) {
        console.error(`\n  ⚡ Found a provider key in the environment, but the test request failed:\n  ${failure}\n`);
        process.exit(1);
      }
    } else {
      p.intro('⚡ Vargos — first-run setup');
      // Loop: the daemon validates the merged config on boot; if the user got a
      // value wrong they land back here rather than in a crash loop.
      // (One pass is normal; the while covers "changed my mind / typo'd the key".)
      let guard = 0;
      while (!providerReady() && guard++ < 5) {
        await configureProvider();
        if (!providerReady()) p.log.warn('Still missing something — let\'s try that again.');
      }
      if (!providerReady()) {
        p.cancel('Could not complete setup. Run "vargos setup" to try again.');
        process.exit(1);
      }
    }
  } else if (interactive && !fresh) {
    p.intro('⚡ Vargos — setup');
  }

  // ── Advisory: external prerequisites for whatever is configured ────────────
  if (interactive) {
    await runDoctors();
  } else {
    await reportProblems(quiet);
  }

  // ── Optional extras — only on a fresh install, only if interactive ─────────
  if (fresh && interactive) {
    await offerEnrichment();
  }

  if (interactive) {
    const web = `http://localhost:${process.env.WEB_PORT || 9003}`;
    p.outro(booting
      ? `Ready — starting Vargos. Web console: ${web}`
      : `Ready. Run "${startCommand()}" to boot the daemon, then open the web console at ${web}`);
  }
}
