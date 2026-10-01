/**
 * `vargos config` — the post-install editor. Everything the first-run journey
 * skips or defers lives here: swap provider/model, add channels, re-check the
 * environment, force-run migrations.
 *
 * `vargos config show` (and `get`) still print the merged config as JSON — see
 * the passthrough in cli.ts.
 */

import * as p from '@clack/prompts';
import { configureProvider } from './provider.js';
import { addChannel } from './enrich.js';
import { runDoctors } from '../scripts/doctors/index.js';
import { runMigrations } from '../lib/migrate.js';

export async function configMenu(): Promise<void> {
  p.intro('⚡ Vargos — config');

  for (;;) {
    const choice = await p.select({
      message: 'What would you like to do?',
      options: [
        { value: 'provider', label: 'Change LLM provider / model' },
        { value: 'channel', label: 'Add a messaging channel' },
        { value: 'doctor', label: 'Re-check the environment' },
        { value: 'migrate', label: 'Run pending migrations' },
        { value: 'exit', label: 'Done' },
      ],
    });

    if (p.isCancel(choice) || choice === 'exit') break;

    switch (choice) {
      case 'provider':
        await configureProvider();
        break;
      case 'channel':
        await addChannel();
        break;
      case 'doctor':
        await runDoctors();
        break;
      case 'migrate':
        await runMigrations({ info: (s) => p.log.info(s), warn: (s) => p.log.warn(s) });
        p.log.success('Migrations up to date.');
        break;
    }
  }

  p.outro('Saved to ~/.vargos/. Restart the daemon to apply.');
}
