/**
 * MCP client service — loads external MCP servers and exposes them as bus events.
 *
 * Inverse of edge/mcp:
 *   edge/mcp exports bus events as MCP tools to external clients (outbound)
 *   this service imports external MCP servers as bus events (inbound)
 *
 * MCP servers are configured in ~/.vargos/agent/mcp.json:
 *   {
 *     "mcpServers": {
 *       "server-name": { command: "node server.js" },
 *     }
 *   }
 *
 * Tools become callable events: mcp.server-name.toolName on the bus
 */

import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Bus, Service } from '../../core/types.js';
import type { AppConfig } from '../../services/config/index.js';
import { createLogger } from '../../lib/logger.js';
import { toMessage } from '../../lib/error.js';
import { getDataPaths } from '../../lib/paths.js';

const log = createLogger('mcp-client');

interface McpServerConnection {
  client: Client;
  tools: Map<string, Tool>;
  registeredTools: Set<string>; // track which tools are registered for cleanup
}

/** Minimal JSON Schema shape we translate into zod for tool introspection. */
interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  enum?: string[];
}

interface McpServerConfig {
  transport?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

// 1-liner format: "server-name": "command with args"
type McpServerEntry = string | McpServerConfig;

function normalizeEntry(entry: McpServerEntry): McpServerConfig {
  return typeof entry === 'string' ? { command: entry } : entry;
}

// ── McpClientService ──────────────────────────────────────────────────────────

export const BOOT_PRIORITY = 40; // external MCP tool imports before agent runs
export class McpClientService implements Service {
  readonly name = 'mcp';
  private servers = new Map<string, McpServerConnection>();
  private bus!: Bus;
  private config!: AppConfig;

  async init(bus: Bus): Promise<void> {
    this.bus = bus;
    this.config = await bus.call<AppConfig>('config.get', {});

    bus.register('mcp.list', {
      external: false,
      description: 'List configured MCP servers (config.mcpServers + agent/mcp.json) with live connection status.',
      schema: z.object({}),
    }, () => this.list());

    await this.start();
  }

  /** config.mcpServers merged with agent/mcp.json (the file wins on key clash). */
  private mergedServers(): Record<string, McpServerEntry> {
    let servers: Record<string, McpServerEntry> = this.config.mcpServers ?? {};
    const mcpConfigPath = getDataPaths().agentMcpFile;
    if (existsSync(mcpConfigPath)) {
      try {
        const parsed = JSON.parse(readFileSync(mcpConfigPath, 'utf8')) as {
          mcpServers?: Record<string, McpServerEntry>;
        };
        if (parsed.mcpServers) servers = { ...servers, ...parsed.mcpServers };
      } catch (err) {
        log.warn(`failed to load agent/mcp.json: ${toMessage(err)}`);
      }
    }
    return servers;
  }

  private list() {
    return Object.entries(this.mergedServers()).map(([name, entry]) => {
      const c = normalizeEntry(entry);
      const conn = this.servers.get(name);
      return {
        name,
        command: c.command ?? null,
        args: c.args ?? [],
        transport: c.transport ?? 'stdio',
        enabled: c.enabled !== false,
        connected: !!conn,
        toolCount: conn ? conn.tools.size : 0,
      };
    });
  }

  private async start(): Promise<void> {
    const mcpServers = this.mergedServers();
    if (Object.keys(mcpServers).length) log.info('loaded MCP servers');

    if (!mcpServers || Object.keys(mcpServers).length === 0) {
      log.debug('no MCP servers configured');
      return;
    }

    for (const [name, entry] of Object.entries(mcpServers)) {
      const serverConfig = normalizeEntry(entry);
      // Skip disabled servers
      if (serverConfig.enabled === false) {
        log.debug(`MCP server disabled: ${name}`);
        continue;
      }

      try {
        await Promise.race([
          this.connectServer(name, serverConfig),
          // 5 second timeout per server to avoid hanging on unavailable servers
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error('connection timeout')), 5000);
          }),
        ]);
      } catch (err) {
        log.warn(`MCP server ${name}: ${toMessage(err)}`);
        // Continue with other servers even if one fails
      }
    }

    if (this.servers.size > 0) {
      log.info(`connected ${this.servers.size} MCP server(s)`);
    } else if (Object.keys(mcpServers).length > 0) {
      log.debug(`no MCP servers available (${Object.keys(mcpServers).length} configured but not connectable)`);
    }
  }

  private async connectServer(name: string, config: McpServerConfig): Promise<void> {
    const transport = config.transport || 'stdio';

    if (transport !== 'stdio') {
      throw new Error(`transport not supported: ${transport} (only stdio supported currently)`);
    }

    // Support both "command" string and "command/args" format
    const cmdStr = config.command;
    if (!cmdStr) throw new Error(`server ${name}: stdio transport requires command`);

    let cmd: string;
    let args: string[];

    if (Array.isArray(config.args)) {
      // Separate command and args arrays
      cmd = cmdStr;
      args = config.args;
    } else {
      // Parse command string with space-separated args
      const parts = cmdStr.split(' ');
      cmd = parts[0];
      args = parts.slice(1);
    }

    // Extract optional env vars
    const env = config.env || {};

    const clientTransport = new StdioClientTransport({
      command: cmd,
      args,
      env: Object.keys(env).length > 0 ? { ...process.env, ...env } as Record<string, string> : undefined,
      stderr: 'ignore', // suppress FastMCP banners and other server startup noise
    });

    const client = new Client({
      name: `vargos-mcp-client-${name}`,
      version: '1.0.0',
    });

    try {
      await client.connect(clientTransport);
      const { tools } = await client.listTools();

      const toolMap = new Map(tools.map(t => [t.name, t]));
      const registeredTools = new Set<string>();
      this.servers.set(name, { client, tools: toolMap, registeredTools });

      log.info(`MCP server connected: ${name} (${tools.length} tools)`);

      // Dynamically register each tool as a bus callable event
      for (const tool of tools) {
        this.registerToolHandler(name, tool, registeredTools);
      }
    } catch (err) {
      await clientTransport.close();
      throw err;
    }
  }

  /**
   * Convert JSON Schema to Zod schema.
   * Handles common JSON Schema properties like type, properties, required, etc.
   */
  private jsonSchemaToZod(jsonSchema: JsonSchemaNode | undefined): z.ZodTypeAny {
    if (!jsonSchema || typeof jsonSchema !== 'object') {
      return z.any();
    }

    const { type, properties, required, items, enum: enumValues } = jsonSchema;

    // Handle enum
    if (enumValues && Array.isArray(enumValues) && enumValues.length > 0) {
      return z.enum(enumValues as [string, ...string[]]);
    }

    // Handle array
    if (type === 'array' || (Array.isArray(type) && type.includes('array'))) {
      const itemSchema = items ? this.jsonSchemaToZod(items) : z.any();
      return z.array(itemSchema);
    }

    // Handle object
    if (type === 'object' || type === undefined || (Array.isArray(type) && type.includes('object'))) {
      if (properties && typeof properties === 'object') {
        const zodProperties: Record<string, z.ZodTypeAny> = {};
        for (const [key, prop] of Object.entries(properties)) {
          zodProperties[key] = this.jsonSchemaToZod(prop);
          // Make fields optional unless explicitly required
          if (!required || !required.includes(key)) {
            zodProperties[key] = zodProperties[key].optional();
          }
        }
        return z.object(zodProperties).passthrough();
      }
      // No properties specified — accept any object
      return z.object({}).passthrough();
    }

    // Handle primitives
    switch (type) {
      case 'string':
        return z.string();
      case 'number':
        return z.number();
      case 'integer':
        return z.number().int();
      case 'boolean':
        return z.boolean();
      case 'null':
        return z.null();
      default:
        return z.any();
    }
  }

  private registerToolHandler(serverName: string, tool: Tool, registeredTools: Set<string>): void {
    const eventName = `mcp.${serverName}.${tool.name}`;

    // Dynamically register the tool as a callable event
    const handler = async (params: unknown) => {
      const connection = this.servers.get(serverName);
      if (!connection) throw new Error(`MCP server not connected: ${serverName}`);

      try {
        const result = await connection.client.callTool({
          name: tool.name,
          arguments: params as Record<string, unknown>,
        }) as CallToolResult;

        // Convert MCP response to bus event result
        const content = result.content ?? [];
        const textContent = content.find(c => c.type === 'text');
        if (result.isError) {
          throw new Error(textContent?.text ?? 'Tool error');
        }
        return textContent
          ? { text: textContent.text }
          : { content };
      } catch (err) {
        log.error(`tool call failed: ${serverName}.${tool.name}: ${toMessage(err)}`);
        throw err;
      }
    };

    // Register with bus using the public registerTool API
    // Convert MCP JSON Schema to Zod schema for introspection
    const zodSchema = this.jsonSchemaToZod(tool.inputSchema as JsonSchemaNode);
    const toolSchema = {
      external: false,
      description: tool.description || `MCP tool: ${tool.name}`,
      schema: zodSchema,
    };
    this.bus.register(eventName, toolSchema, handler);
    registeredTools.add(eventName);
  }

  async dispose(): Promise<void> {
    for (const { client, registeredTools } of this.servers.values()) {
      // Bus methods are auto-released on reload, but unregister explicitly for clarity.
      for (const eventName of registeredTools) this.bus.unregister(eventName);
      registeredTools.clear();
      try {
        await client.close();
      } catch {
        // best effort
      }
    }
    this.servers.clear();
  }
}

export function createService(): Service {
  return new McpClientService();
}
