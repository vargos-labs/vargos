/** Outward activity shown by the voice console; arguments and raw results stay private. */
export interface VoiceActivity {
  id: string;
  kind: 'task' | 'tool' | 'skill';
  label: string;
  state: 'running' | 'completed' | 'failed';
}
