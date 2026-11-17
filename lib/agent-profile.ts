import type { Skill, ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { VoiceModelInfo } from './voice.js';

/** Serializable agent resources for runtimes that consume Vargos bus tools. */
export interface AgentProfile {
  options?: { allowedTools?: string[]; skills?: string[] };
  model?: VoiceModelInfo;
  systemPrompt: string;
  tools: Array<Pick<ToolDefinition, 'name' | 'description' | 'parameters'> & { method: string }>;
  skills: Array<Pick<Skill, 'name' | 'description' | 'filePath'>>;
}
