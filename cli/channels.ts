/**
 * Channel setup helpers for first-run enrichment / `vargos config`. Writes config.json directly because
 * onboarding runs before any daemon exists. Live channel ops go through the bus
 * (`vargos channel …` / RpcClient), not here.
 */

import https from 'node:https';
import path from 'node:path';
import qrcode from 'qrcode-terminal';
import { getDataPaths } from '../lib/paths.js';
import { readJson, writeJson } from '../lib/util.js';
import type { ChannelEntry } from '../services/config/schemas/channels.js';

export interface RegisterChannelParams {
  id: string;
  type: ChannelEntry['type'];
  botToken?: string; // Telegram only
  /** Sender IDs allowed to reach the agent; omitted = anyone. */
  allowFrom?: string[];
}

interface ConfigFile {
  channels?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

function readConfig(): ConfigFile {
  const { configFile } = getDataPaths();
  return readJson<ConfigFile>(configFile) ?? {};
}

function writeConfig(config: ConfigFile): void {
  writeJson(getDataPaths().configFile, config);
}

/**
 * Upsert a channel into config.json. Idempotent: re-registering an existing id leaves
 * it in place (refreshing the bot token if supplied). Returns whether it was created.
 */
export function registerChannel(params: RegisterChannelParams): { created: boolean } {
  const config = readConfig();
  const channels = (config.channels ?? []) as Array<Record<string, unknown>>;

  const existing = channels.find((c) => c.id === params.id);
  if (existing) {
    if (params.botToken) existing['botToken'] = params.botToken;
    if (params.allowFrom) existing['allowFrom'] = params.allowFrom;
    config.channels = channels;
    writeConfig(config);
    return { created: false };
  }

  const entry: Record<string, unknown> = { id: params.id, type: params.type, enabled: true };
  if (params.botToken) entry['botToken'] = params.botToken;
  if (params.allowFrom) entry['allowFrom'] = params.allowFrom;
  channels.push(entry);
  config.channels = channels;
  writeConfig(config);
  return { created: true };
}

// ── Telegram onboarding (direct Bot API — no daemon yet) ────────────────────────

interface TelegramResponse<T> { ok: boolean; result?: T; description?: string }
interface TelegramUpdate {
  update_id: number;
  message?: { chat: { type: string }; from?: { id: number; first_name?: string; username?: string } };
}

/** Telegram answered and said no (bad token, conflict) — as opposed to "couldn't reach it". */
export class TelegramRejected extends Error {}

/**
 * One Bot API call. IPv4 via https.request, like the channel adapter: Node's fetch Happy
 * Eyeballs times out on hosts with a broken IPv6 route, where curl works fine.
 */
function telegram<T>(token: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
  const payload = Buffer.from(JSON.stringify(params));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      family: 4,
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as TelegramResponse<T>;
          if (body.ok) resolve(body.result as T);
          else reject(new TelegramRejected(body.description ?? `Telegram ${method} failed (HTTP ${res.statusCode})`));
        } catch {
          reject(new Error(`Telegram ${method}: unexpected reply (HTTP ${res.statusCode})`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`no reply from api.telegram.org within ${timeoutMs / 1000}s`)));
    req.on('error', reject);
    req.end(payload);
  });
}

/** Validate a bot token. Returns the bot's @username; throws with Telegram's reason. */
export async function telegramBotName(token: string): Promise<string> {
  return (await telegram<{ username: string }>(token, 'getMe')).username;
}

/**
 * Wait for someone to DM the bot and return who it was — how a user learns their own
 * Telegram ID without a lookup bot. The update is acknowledged so the daemon won't
 * later treat that "hi" as a task. Null on timeout.
 */
export async function waitForTelegramSender(token: string, timeoutSec = 90): Promise<{ id: string; name: string } | null> {
  const deadline = Date.now() + timeoutSec * 1000;
  // Skip anything sent before we started listening.
  const backlog = await telegram<TelegramUpdate[]>(token, 'getUpdates', { offset: -1, timeout: 0 });
  let offset = backlog.length ? backlog[backlog.length - 1].update_id + 1 : 0;

  while (Date.now() < deadline) {
    const wait = Math.max(1, Math.min(25, Math.round((deadline - Date.now()) / 1000)));
    const updates = await telegram<TelegramUpdate[]>(
      token, 'getUpdates', { offset, timeout: wait, allowed_updates: ['message'] }, (wait + 10) * 1000,
    );
    for (const u of updates) {
      offset = u.update_id + 1;
      const from = u.message?.chat.type === 'private' ? u.message.from : undefined;
      if (!from) continue;
      await telegram(token, 'getUpdates', { offset, timeout: 0 });
      return { id: String(from.id), name: from.username ? `@${from.username}` : (from.first_name ?? String(from.id)) };
    }
  }
  return null;
}

/** Standalone WhatsApp QR pairing (loads Baileys only when called). */
export async function pairWhatsApp(id: string): Promise<void> {
  const authDir = path.join(getDataPaths().channelsDir, id);
  const { createWhatsAppSocket } = await import('../services/channel/providers/whatsapp/session.js');

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let connected = false;
    let qrShown = false;
    let restarts = 0;

    const connect = async (): Promise<void> => {
      await createWhatsAppSocket(authDir, {
        onQR: (qr) => {
          if (qrShown) {
            // Baileys rotated the QR — the previous one expired before it was scanned.
            // Exit cleanly so the user can re-run and get a fresh code immediately.
            if (!settled) {
              settled = true;
              reject(new Error('QR code expired before scan. Re-run the command to get a fresh QR.'));
            }
            return;
          }
          qrShown = true;
          qrcode.generate(qr, { small: true });
          console.log('\n  Scan the QR above with WhatsApp → Linked Devices.\n');
        },
        onConnected: (name) => {
          if (settled) return;
          connected = true;
          console.log(`\n✅ Connected as ${name}`);
          console.log(`   Saving credentials…`);
          // Do not resolve here — wait for onCredsSaved to confirm the disk write completed.
          // Resolving at connection.open risks process.exit() truncating the creds.json write.
        },
        onCredsSaved: () => {
          if (!connected || settled) return;
          settled = true;
          console.log(`   Credentials saved to ${authDir}/creds.json\n`);
          resolve();
        },
        onDisconnected: (reason) => {
          if (settled) return;
          // Baileys closes with restart_required immediately after a successful scan — the
          // creds are saved, but login only completes after reconnecting. This is normal.
          if (reason === 'restart_required' && restarts++ < 5) {
            console.log('  Scan accepted — finishing login…');
            connect().catch(err => { if (!settled) { settled = true; reject(err); } });
            return;
          }
          settled = true;
          if (reason === 'logged_out') reject(new Error('Pairing failed — device logged out. Try again.'));
          else if (reason === 'forbidden') reject(new Error('Pairing failed — access forbidden.'));
          else reject(new Error(`Pairing failed — connection closed (${reason}). Re-run with --reset to retry.`));
        },
        onMessage: () => {},
      });
    };

    connect().catch(reject);
  });
}
