/**
 * Optional setup — messaging channels and the MCP adapter. Never required to run
 * the agent, so this is offered at the end of first-run and from `vargos config`,
 * never as a gate.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { getDataPaths } from '../lib/paths.js';
import { readJson } from '../lib/util.js';
import { registerChannel, pairWhatsApp } from './channels.js';
import { ensureMcpAdapter, resolvePiCli, MCP_ADAPTER_SPEC } from './mcp-adapter.js';

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

  const id = await p.text({
    message: 'Channel ID (short name for this connection)',
    placeholder: type === 'telegram' ? 'telegram-bot' : 'whatsapp-personal',
    validate: (v) => {
      if (!v) return 'Required';
      if (!/^[a-z0-9_-]+$/.test(v)) return 'lowercase letters, numbers, - and _ only';
      return undefined;
    },
  });
  if (p.isCancel(id)) return;

  try {
    if (type === 'telegram') {
      const botTokenInput = await p.password({
        message: 'Telegram bot token',
        validate: (v) => (v ? undefined : 'Required'),
      });
      if (p.isCancel(botTokenInput)) return;
      registerChannel({ id, type: 'telegram', botToken: botTokenInput });
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
    p.log.error(`Failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Install/upgrade the pi MCP adapter so the agent can load MCP tools. */
export async function enableMcp(): Promise<void> {
  const { dataDir } = getDataPaths();
  const agentDir = path.join(dataDir, 'agent');
  const spin = p.spinner();
  spin.start('Installing MCP adapter');
  try {
    const settings = readJson<{ packages?: string[] }>(path.join(agentDir, 'settings.json')) ?? {};
    // resolvePiCli walks up from this file; in dev/dist it finds the workspace copy.
    spin.stop(ensureMcpAdapter(agentDir, resolvePiCli(path.dirname(fileURLToPath(import.meta.url))), settings.packages ?? []));
  } catch {
    spin.stop(`Skipped — install later: pi install ${MCP_ADAPTER_SPEC}`);
  }
}

/** First-run tail: offer the optional extras once, in sequence. */
export async function offerEnrichment(): Promise<void> {
  p.note(
    'Optional — talk to your agent from your phone, or give it MCP tools.\nSkip any of this and add it later with "vargos config".',
    'Extras',
  );

  const wantChannel = await p.confirm({ message: 'Connect a messaging channel now?', initialValue: false });
  if (!p.isCancel(wantChannel) && wantChannel) await addChannel();

  const wantMcp = await p.confirm({ message: 'Install the MCP adapter now?', initialValue: false });
  if (!p.isCancel(wantMcp) && wantMcp) await enableMcp();
}
