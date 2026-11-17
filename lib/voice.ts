import { z } from 'zod';

/** Outward activity shown by the voice console; arguments and raw results stay private. */
export interface VoiceActivity {
  id: string;
  kind: 'task' | 'tool' | 'skill';
  label: string;
  method?: string;
  state: 'running' | 'completed' | 'failed';
}

export const voiceModelSchema = z.object({
  id: z.string(),
  provider: z.string(),
  contextWindow: z.number().int().positive(),
});
export type VoiceModelInfo = z.infer<typeof voiceModelSchema>;

/** Presentation-only commands; service mutations continue through canonical bus tools. */
export const workspaceCommandSchema = z.object({
  action: z.enum(['find', 'open', 'back', 'pin', 'compare', 'move']),
  target: z.string().max(200).optional().describe('Exact resource ID from find; omit to use the selected object.'),
  query: z.string().max(200).optional().describe('Search title or summary when action is find.'),
  position: z.enum(['left', 'right', 'center']).optional(),
});
export type WorkspaceCommand = z.infer<typeof workspaceCommandSchema>;
export const workspaceResultSchema = z.object({
  type: z.literal('voice.workspace.result'),
  callId: z.string().max(200),
  result: z.string().max(16000),
});
