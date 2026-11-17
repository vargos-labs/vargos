import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { AgentService } from '../index.js';
import { AppConfigSchema } from '../../config/index.js';
import { EmitterBus } from '../../../core/bus.js';
import { resetDataPaths } from '../../../lib/paths.js';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { getDataPaths } from '../../../lib/paths.js';
import type { AgentProfile } from '../../../lib/agent-profile.js';

class ProfileRuntime extends AgentService {
  constructor(bus: EmitterBus) {
    super();
    this.bus = bus;
    this.config = AppConfigSchema.parse({});
    this.agentDir = getDataPaths().agentDir;
    this.settings = SettingsManager.create(getDataPaths().workspaceDir, this.agentDir);
    this['registerMethods'](bus);
  }
}

describe('agent.profile', () => {
  let directory: string;
  let previous: string | undefined;
  let bus: EmitterBus;
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'agent-profile-'));
    previous = process.env.VARGOS_DATA_DIR;
    process.env.VARGOS_DATA_DIR = directory;
    resetDataPaths();
    mkdirSync(path.join(directory, 'agents'));
    mkdirSync(path.join(directory, 'workspace'));
    writeFileSync(path.join(directory, 'agents/default.md'), 'Default persona');
    writeFileSync(path.join(directory, 'agents/voice.md'), '---\nallowedTools: []\n---\nKeep spoken answers concise.');
    writeFileSync(path.join(directory, 'workspace/SOUL.md'), 'Shared Vargos identity.');
    mkdirSync(path.join(directory, 'agent/skills/research'), { recursive: true });
    writeFileSync(path.join(directory, 'agent/skills/research/SKILL.md'), '---\nname: research\ndescription: Research a topic.\n---\nPrivate skill body, loaded on demand.');
    mkdirSync(path.join(directory, 'agent/skills/manual'), { recursive: true });
    writeFileSync(path.join(directory, 'agent/skills/manual/SKILL.md'), '---\nname: manual\ndescription: Explicit invocation only.\ndisable-model-invocation: true\n---\nManual skill.');
    bus = new EmitterBus();
    new ProfileRuntime(bus);
    bus.register('memory.search', { description: 'Search memory', schema: z.object({ query: z.string() }) }, () => []);
    bus.register('mcp.local.inspect', { description: 'Internal MCP tool', external: false, schema: z.object({}) }, () => []);
    bus.register('private.secret', { description: 'Hidden', internal: true, schema: z.object({}) }, () => []);
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.VARGOS_DATA_DIR;
    else process.env.VARGOS_DATA_DIR = previous;
    resetDataPaths();
    rmSync(directory, { recursive: true, force: true });
  });
  it('reuses bootstrap instructions, persona, tool names, and canonical schemas without an inference session', async () => {
    const profile = await bus.call<AgentProfile>('agent.profile', { sessionKey: 'web:voice:test', persona: 'voice' });
    expect(profile.systemPrompt).toContain('Shared Vargos identity.');
    expect(profile.systemPrompt).toContain('Keep spoken answers concise.');
    expect(profile.skills).toContainEqual({ name: 'research', description: 'Research a topic.', filePath: path.join(directory, 'agent/skills/research/SKILL.md') });
    expect(profile.skills.some(skill => skill.name === 'manual')).toBe(false);
    expect(JSON.stringify(profile)).not.toContain('Private skill body');
    expect(profile.tools.find(tool => tool.method === 'memory.search')).toMatchObject({ name: 'memory-search', parameters: bus.list('memory')[0].schema });
    expect(profile.tools.some(tool => tool.method === 'mcp.local.inspect')).toBe(true);
    expect(profile.tools.some(tool => tool.method === 'private.secret')).toBe(false);
    expect(profile.tools.some(tool => tool.method === 'agent.profile')).toBe(false);
    expect(bus.list('agent').find(method => method.name === 'agent.profile')?.internal).toBe(true);
  });
  it('re-reads the persona whitelist and preserves custom voice instructions', async () => {
    writeFileSync(path.join(directory, 'agents/voice.md'), '---\nallowedTools: [memory.*]\n---\nMy custom voice instructions.');
    const profile = await bus.call<AgentProfile>('agent.profile', { sessionKey: 'web:voice:test', persona: 'voice' });
    expect(profile.tools.map(tool => tool.method)).toEqual(['memory.search']);
    expect(profile.options?.allowedTools).toEqual(['memory.*']);
    expect(profile.systemPrompt).toContain('My custom voice instructions.');
  });
  it('filters discovered skills through the existing resource loader', async () => {
    writeFileSync(path.join(directory, 'agents/voice.md'), '---\nskills: [other-*]\n---\n');
    const profile = await bus.call<AgentProfile>('agent.profile', { sessionKey: 'web:voice:test', persona: 'voice' });
    expect(profile.skills).toEqual([]);
    writeFileSync(path.join(directory, 'agents/voice.md'), '---\nskills: []\n---\n');
    const inherited = await bus.call<AgentProfile>('agent.profile', { sessionKey: 'web:voice:test', persona: 'voice' });
    expect(inherited.skills.map(skill => skill.name)).toContain('research');
  });
  it('validates persona metadata instead of casting malformed values', async () => {
    writeFileSync(path.join(directory, 'agents/voice.md'), '---\nreasoningEffort: invalid\n---\n');
    await expect(bus.call('agent.profile', { sessionKey: 'web:voice:test', persona: 'voice' })).rejects.toThrow();
  });
  it('rejects persona paths outside the agents directory', async () => {
    await expect(bus.call('agent.profile', { sessionKey: 'web:voice:test', persona: '../secret' })).rejects.toThrow();
  });
});
