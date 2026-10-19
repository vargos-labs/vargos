/**
 * 003 — undo two first-run defaults that broke fresh installs.
 *
 *   1. `.templates/config.json` used to seed an *enabled* example Telegram channel
 *      (`telegram-vargos-template`, fake token), so every boot logged a getMe 404. The
 *      template now ships `channels: []`; this drops the example from installs that still
 *      carry it untouched (a real token means the user adopted it — kept).
 *   2. The old setup wizard wrote `api: "anthropic"` (not a Pi API — the real one is
 *      `anthropic-messages`) with base URL `https://api.anthropic.com/v1` (Pi appends
 *      `/v1/messages` itself), so every request failed with "No API provider registered".
 *      The wizard's own unmodified entry is removed so Pi's built-in Anthropic provider and
 *      model catalog apply; any other entry using that api id is repaired in place.
 */

import { existsSync } from 'node:fs';
import type { Migration } from '../lib/migrate.js';
import { readJson, writeJson } from '../lib/util.js';

const TEMPLATE_CHANNEL_ID = 'telegram-vargos-template';
const TEMPLATE_BOT_PLACEHOLDER = 'xxxxxxxxxx:Xxxxxxxxxxxxx-Xxxxxxxxxxxxxxxxxxxxx';
const OLD_ANTHROPIC_URL = 'https://api.anthropic.com/v1';

/** The seeded example, still with its fake credential (a real one means the user adopted it). */
function isUntouchedTemplate(c: { id?: string; botToken?: string }): boolean {
  return c.id === TEMPLATE_CHANNEL_ID && Object.is(c.botToken, TEMPLATE_BOT_PLACEHOLDER);
}

interface ProviderEntry { api?: string; baseUrl?: string; [key: string]: unknown }

const migration: Migration = {
  id: '003-drop-setup-placeholders',
  description: 'Remove the example Telegram channel and repair the old Anthropic provider entry',
  async run({ paths, log }) {
    const config = readJson<{ channels?: Array<{ id?: string; botToken?: string }> }>(paths.configFile);
    const channels = config?.channels;
    if (channels?.some(isUntouchedTemplate)) {
      config!.channels = channels.filter(c => !isUntouchedTemplate(c));
      writeJson(paths.configFile, config);
      log.info(`removed example channel "${TEMPLATE_CHANNEL_ID}" from config.json`);
    }

    if (!existsSync(paths.agentModelsFile)) return;
    const models = readJson<{ providers?: Record<string, ProviderEntry> }>(paths.agentModelsFile);
    const providers = models?.providers;
    if (!providers) return;

    let changed = false;
    for (const [name, entry] of Object.entries(providers)) {
      if (entry.api !== 'anthropic') continue;
      changed = true;
      if (name === 'anthropic' && entry.baseUrl === OLD_ANTHROPIC_URL && !entry.apiKey) {
        delete providers[name];
        log.info('removed the old wizard\'s anthropic entry from models.json — using Pi\'s built-in provider');
        continue;
      }
      entry.api = 'anthropic-messages';
      if (entry.baseUrl?.endsWith('/v1')) entry.baseUrl = entry.baseUrl.slice(0, -'/v1'.length);
      log.info(`repaired provider "${name}" in models.json (api → anthropic-messages)`);
    }
    if (changed) writeJson(paths.agentModelsFile, models);
  },
};

export default migration;
