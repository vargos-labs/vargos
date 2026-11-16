import type { Skill, ToolDefinition } from '@earendil-works/pi-coding-agent';

/** Serializable agent resources for runtimes that consume Vargos bus tools. */
export interface AgentProfile {
  systemPrompt: string;
  tools: Array<Pick<ToolDefinition, 'name' | 'description' | 'parameters'> & { method: string }>;
  skills: Array<Pick<Skill, 'name' | 'description' | 'filePath'>>;
}
