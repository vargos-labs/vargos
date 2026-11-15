import { describe, it, expect } from 'vitest';
import {
  subagentSessionKey,
  mcpAgentSessionKey,
  isSubagentSession,
  rootSessionKey,
  parseSessionKey,
  cronSessionKey,
  webhookSessionKey,
  parseChannelTarget,
} from '../session-key.js';

describe('subagentSessionKey', () => {
  it('produces a key with :subagent: segment', () => {
    const key = subagentSessionKey('telegram:user123');
    expect(key).toMatch(/^telegram:user123:subagent:[0-9a-f]+$/);
  });

  it('produces unique keys on each call', () => {
    const keys = new Set(Array.from({ length: 20 }, () => subagentSessionKey('telegram:user123')));
    expect(keys.size).toBe(20);
  });

  it('preserves the parent key prefix', () => {
    const key = subagentSessionKey('cli:session-42');
    expect(key.startsWith('cli:session-42:subagent:')).toBe(true);
  });
});

describe('isSubagentSession', () => {
  it('returns false for regular session keys', () => {
    expect(isSubagentSession('telegram:user123')).toBe(false);
    expect(isSubagentSession('cli:session-1')).toBe(false);
    expect(isSubagentSession('cron:daily:2026-05-22')).toBe(false);
  });

  it('returns true for subagent session keys', () => {
    expect(isSubagentSession('telegram:user123:subagent:abc12345')).toBe(true);
    expect(isSubagentSession('cli:session-1:subagent:deadbeef')).toBe(true);
  });

  it('returns true even for nested subagent patterns', () => {
    // Shouldn't happen in practice, but the function is defensive
    expect(isSubagentSession('telegram:user123:subagent:abc:subagent:def')).toBe(true);
  });
});

describe('rootSessionKey', () => {
  it('returns the key unchanged when no subagent suffix', () => {
    expect(rootSessionKey('telegram:user123')).toBe('telegram:user123');
    expect(rootSessionKey('cli:session-1')).toBe('cli:session-1');
  });

  it('strips :subagent: suffix', () => {
    expect(rootSessionKey('telegram:user123:subagent:abc12345')).toBe('telegram:user123');
  });

  it('strips everything after the first :subagent: (handles nested)', () => {
    expect(rootSessionKey('telegram:user123:subagent:abc:subagent:def')).toBe('telegram:user123');
  });
});

describe('parseSessionKey', () => {
  it('extracts type and id from regular session keys', () => {
    expect(parseSessionKey('telegram:user123')).toEqual({ type: 'telegram', id: 'user123' });
    expect(parseSessionKey('cli:session-1')).toEqual({ type: 'cli', id: 'session-1' });
  });

  it('extracts type and id from subagent session keys (strips suffix)', () => {
    expect(parseSessionKey('telegram:user123:subagent:abc12345')).toEqual({
      type: 'telegram',
      id: 'user123',
    });
  });

  it('handles session keys with colons in the id', () => {
    expect(parseSessionKey('cron:daily-backup:2026-05-22')).toEqual({
      type: 'cron',
      id: 'daily-backup:2026-05-22',
    });
  });

  it('handles session keys without a colon', () => {
    expect(parseSessionKey('noseparator')).toEqual({ type: 'noseparator', id: '' });
  });
});

describe('cronSessionKey', () => {
  it('produces cron:<taskId>:<date> format', () => {
    const key = cronSessionKey('daily-backup');
    expect(key).toMatch(/^cron:daily-backup:\d{4}-\d{2}-\d{2}$/);
  });
});

describe('webhookSessionKey', () => {
  it('produces webhook:<hookId>:<timestamp> format', () => {
    const key = webhookSessionKey('hook-1');
    expect(key).toMatch(/^webhook:hook-1:\d+$/);
  });
});

describe('parseChannelTarget', () => {
  it('parses channel:userId format', () => {
    expect(parseChannelTarget('telegram:user123')).toEqual({
      channel: 'telegram',
      userId: 'user123',
    });
  });

  it('returns null when no userId', () => {
    expect(parseChannelTarget('telegram')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseChannelTarget('')).toBeNull();
  });
});


describe('mcpAgentSessionKey', () => {
  it.each([
    ['Research AI News!', 'mcp:agent:research-ai-news'],
    ['  Café / sources..  ', 'mcp:agent:cafe-sources'],
    ['../../', 'mcp:agent:task'],
    ['研究 新闻', 'mcp:agent:研究-新闻'],
  ])('creates a stable safe key for %s', (name, expected) => {
    expect(mcpAgentSessionKey(name)).toBe(expected);
  });
  it('bounds the slug length', () => {
    expect(mcpAgentSessionKey('a'.repeat(200))).toBe(`mcp:agent:${'a'.repeat(80)}`);
  });
});
