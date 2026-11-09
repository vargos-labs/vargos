/**
 * Optional setup — messaging channels. Never required to run the agent, so this is
 * offered at the end of first-run and from `vargos config`, never as a gate.
 */

import * as p from '@clack/prompts';
import { registerChannel, pairWhatsApp, telegramBotName, waitForTelegramSender, TelegramRejected } from './channels.js';
import { permissionHint } from '../lib/error.js';
import { getDataPaths } from '../lib/paths.js';

/** Add one Telegram or WhatsApp channel. */
export async function addChannel(): Promise<void> {
  const type = await p.select({
    message: 'Channel',
    options: [
      { value: 'telegram', label: 'Telegram', hint: 'bot token from @BotFather' },
      { value: 'whatsapp', label: 'WhatsApp', hint: 'QR pairing' },
    ],
  });
  if (p.isCancel(type)) return;

  const suggested = type === 'telegram' ? 'telegram-bot' : 'whatsapp-personal';
  const id = await p.text({
    message: 'Channel ID (short name for this connection)',
    placeholder: suggested,
    defaultValue: suggested,
    validate: (v) => {
      if (!v) return undefined; // empty → defaultValue
      if (!/^[a-z0-9_-]+$/.test(v)) return 'lowercase letters, numbers, - and _ only';
      return undefined;
    },
  });
  if (p.isCancel(id)) return;

  try {
    if (type === 'telegram') {
      const telegram = await setupTelegram();
      if (!telegram) return;
      registerChannel({ id, type: 'telegram', ...telegram });
      p.log.success(`"${id}" registered — comes online on next "vargos start".`);
      return;
    }

    registerChannel({ id, type: 'whatsapp' });
    const pair = await p.confirm({ message: 'Pair WhatsApp now? (QR in terminal)', initialValue: true });
    if (!p.isCancel(pair) && pair) {
      console.log('\n  Scan with WhatsApp → Linked Devices\n');
      try {
        await pairWhatsApp(id);
      } catch (err) {
        p.log.warn(`Pairing failed: ${err instanceof Error ? err.message : err}. Retry: vargos channel pair ${id}`);
      }
    } else {
      p.log.success(`"${id}" registered — pair later: vargos channel pair ${id}`);
    }
  } catch (err) {
    p.log.error(permissionHint(err, getDataPaths().dataDir) ?? `Failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Token (checked against Telegram) + who may talk to the bot. Undefined on cancel. */
async function setupTelegram(): Promise<{ botToken: string; allowFrom?: string[] } | undefined> {
  let creds: { botToken: string; bot: string };
  for (;;) {
    const input = await p.password({
      message: 'Telegram bot token (from @BotFather → /newbot)',
      validate: (v) => (v ? undefined : 'Required'),
    });
    if (p.isCancel(input)) return undefined;
    const spin = p.spinner();
    spin.start('Checking the token with Telegram');
    try {
      creds = { botToken: input, bot: await telegramBotName(input) };
      spin.stop(`Bot: @${creds.bot}`);
      break;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (err instanceof TelegramRejected) {
        spin.error('Telegram rejected the token');
        p.log.error(`${reason} — copy it again from @BotFather.`);
        continue;
      }
      spin.error("Couldn't reach Telegram");
      p.log.error(`${reason} — check this machine's network access to api.telegram.org.`);
      const retry = await p.confirm({ message: 'Try again?', initialValue: true });
      if (p.isCancel(retry) || !retry) return undefined;
    }
  }

  const { botToken, bot } = creds;

  // The agent can run tools on this machine — default to "only you", not "anyone who finds the bot".
  const spin = p.spinner();
  spin.start(`Send any message to @${bot} from your own Telegram account (waiting 90s)…`);
  let sender: { id: string; name: string } | null = null;
  try {
    sender = await waitForTelegramSender(botToken);
  } catch (err) {
    p.log.warn(`Couldn't read messages: ${err instanceof Error ? err.message : err}`);
  }
  spin.stop(sender ? `Got a message from ${sender.name} (${sender.id})` : 'No message received');

  if (sender) {
    const onlyMe = await p.confirm({ message: `Let only ${sender.name} talk to the agent?`, initialValue: true });
    if (p.isCancel(onlyMe)) return undefined;
    if (onlyMe) return { botToken, allowFrom: [sender.id] };
  }

  const ids = await p.text({
    message: 'Allowed Telegram user IDs, comma-separated (Enter = anyone who finds the bot)',
    placeholder: '123456789',
  });
  if (p.isCancel(ids)) return undefined;
  const allowFrom = (ids ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowFrom.length) p.log.warn(`Anyone who messages @${bot} can use the agent. Restrict later with allowFrom in config.json.`);
  return { botToken, ...(allowFrom.length ? { allowFrom } : {}) };
}

/** First-run tail: offer the optional extras once, in sequence. */
export async function offerEnrichment(): Promise<void> {
  p.note(
    'Optional — talk to your agent from your phone.\nSkip this and add it later with "vargos config".',
    'Extras',
  );

  const wantChannel = await p.confirm({ message: 'Connect a messaging channel now?', initialValue: false });
  if (!p.isCancel(wantChannel) && wantChannel) await addChannel();
}
