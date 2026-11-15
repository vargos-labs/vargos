import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Progress } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AgentService } from '../../../services/agent/index.js';
import type { AppConfig } from '../../../services/config/index.js';
import { EmitterBus } from '../../../core/bus.js';
import { McpEdge } from '../index.js';

const PORT = 9139;

/** Real AgentService execution and lifecycle mapping, with only the Pi session simulated. */
class ExecutionRuntime extends AgentService {
  key?: string;
  release?: () => void;
  setThinkingLevel = vi.fn();
  constructor(bus: EmitterBus) {
    super();
    this.bus = bus;
    this.config = { agent: { executionTimeoutMs: 10000 } } as AppConfig;
    this['registerMethods'](bus);
  }
  protected async getOrCreateSession(key: string): Promise<AgentSession> {
    this.key = key;
    let listener!: (event: AgentSessionEvent) => void;
    const emit = (event: unknown) => { listener(event as AgentSessionEvent); };
    const session = {
      subscribe: (callback: typeof listener) => { listener = callback; return () => {}; },
      setThinkingLevel: this.setThinkingLevel,
      state: { messages: [{ role: 'assistant', content: 'Completed research' }] },
      prompt: async () => {
        emit({ type: 'tool_execution_start', toolName: 'search', toolCallId: '1', args: { secret: 'private' } });
        emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', content: 'private reasoning' } });
        emit({ type: 'message_update', assistantMessageEvent: {
          type: 'text_end', content: 'I found three sources; checking their dates.', partial: { secret: 'private' },
        } });
        await new Promise<void>(resolve => { this.release = resolve; });
        emit({ type: 'tool_execution_end', toolName: 'search', toolCallId: '1', isError: false, result: { secret: 'private' } });
      },
    } as unknown as AgentSession;
    this.subscribeToSessionEvents(session, key);
    return session;
  }
}

describe('agent.execute progress end to end', () => {
  let edge: McpEdge;
  let client: Client;
  let runtime: ExecutionRuntime;
  let oldPort: string | undefined;
  beforeAll(async () => {
    oldPort = process.env.MCP_PORT;
    process.env.MCP_PORT = String(PORT);
    const bus = new EmitterBus();
    bus.register('config.get', { schema: z.object({}), description: 'Config', internal: true }, () => ({
      mcp: { host: '127.0.0.1', port: PORT, bearerToken: 'test' },
    }));
    runtime = new ExecutionRuntime(bus);
    edge = new McpEdge();
    await edge.init(bus);
    client = new Client({ name: 'execution-progress-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer test' } },
    }));
  });
  afterAll(async () => {
    runtime.release?.();
    await client.close();
    await edge.dispose();
    if (oldPort === undefined) delete process.env.MCP_PORT;
    else process.env.MCP_PORT = oldPort;
  });

  it('delivers useful progress before execution finishes, with task naming and reasoning applied', async () => {
    const tools = (await client.listTools()).tools;
    const execute = tools.find(tool => tool.name === 'agent.execute')!;
    expect(execute.description).toContain('configured skills');
    expect(execute.inputSchema.properties).toHaveProperty('taskName');
    expect(execute.inputSchema.properties).toHaveProperty('reasoningEffort');
    const updates: Progress[] = [];
    let completed = false;
    let sawText!: () => void;
    const textArrived = new Promise<void>(resolve => { sawText = resolve; });
    const call = client.callTool({ name: 'agent.execute', arguments: {
      task: 'Research current sources', taskName: 'Daily Research!', reasoningEffort: 'high',
    } }, undefined, { onprogress: update => {
      updates.push(update);
      if (JSON.parse(update.message!).type === 'message_update') sawText();
    } }).then(result => { completed = true; return result; });
    try {
      await textArrived;
      expect(completed).toBe(false);
      expect(runtime.key).toBe('mcp:agent:daily-research');
      expect(runtime.setThinkingLevel).toHaveBeenCalledWith('high', { persist: false });
      expect(JSON.parse(updates[1].message!).assistantMessageEvent.content).toContain('three sources');
    } finally {
      runtime.release?.();
    }
    const result = await call;
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ response: 'Completed research' }) }]);
    expect(updates.map(update => update.progress)).toEqual([1, 2, 3]);
    expect(JSON.stringify(updates)).not.toMatch(/private|thinking_end/);
  });
});
