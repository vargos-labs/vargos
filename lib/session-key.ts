/**
 * Pure session key helpers — no domain dependencies.
 */
import { randomBytes } from 'node:crypto';

/** Stable MCP conversation key derived from a human-readable task name. */
export function mcpAgentSessionKey(taskName: string): string {
  const slug = taskName.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 80).replace(/^-+|-+$/g, '');
  return `mcp:agent:${slug || 'task'}`;
}

export function cronSessionKey(taskId: string): string {
  return `cron:${taskId}:${new Date().toISOString().slice(0, 10)}`;
}

export function webhookSessionKey(hookId: string): string {
  return `webhook:${hookId}:${Date.now()}`;
}

/**
 * Generate a unique subagent session key from the parent key.
 * Appends `:subagent:<shortId>` so each delegation gets its own session,
 * enabling parallel subagents without collision.
 */
export function subagentSessionKey(parentKey: string): string {
  const shortId = randomBytes(4).toString('hex');
  return `${parentKey}:subagent:${shortId}`;
}

/** Check if a sessionKey belongs to any subagent (any depth). */
export function isSubagentSession(key: string): boolean {
  return key.includes(':subagent:');
}

/** Extract the root parent sessionKey by stripping all subagent suffixes. */
export function rootSessionKey(key: string): string {
  const idx = key.indexOf(':subagent:');
  return idx === -1 ? key : key.slice(0, idx);
}

/** Parse "type:id" format from a string, extracting first component. */
function parseTypeIdFormat(str: string): { type: string; id: string } {
  const sep = str.indexOf(':');
  if (sep === -1) return { type: str, id: '' };
  return { type: str.slice(0, sep), id: str.slice(sep + 1) };
}

export function parseSessionKey(key: string): { type: string; id: string } {
  const root = rootSessionKey(key);
  return parseTypeIdFormat(root);
}

export function parseChannelTarget(target: string): { channel: string; userId: string } | null {
  const { type: channel, id: userId } = parseTypeIdFormat(target);
  return userId ? { channel, userId } : null;
}
