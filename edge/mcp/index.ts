/**
 * MCP edge service — translates MCP protocol to bus event calls.
 *
 * ListToolsRequest  → bus.list()
 * CallToolRequest   → bus.call(method, args)
 *
 * Supports HTTP (StreamableHTTP) transport on port 9001.
 * Bearer token auth from config.mcp.bearerToken.
 *
 * HTTP is stateless: each request gets its own `Server` + `StreamableHTTPServerTransport`
 * (`sessionIdGenerator: undefined`), so any number of clients can initialize, reconnect and
 * disconnect independently. One shared transport rejects the second `initialize` with
 * "Server already initialized" and demands a `Mcp-Session-Id` that clients never receive.
 */

import http from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Bus, Service } from '../../core/types.js';
import type { AppConfig } from '../../services/config/index.js';
import { createLogger } from '../../lib/logger.js';
import { toMessage } from '../../lib/error.js';

const log = createLogger('mcp');

const VERSION = '0.0.1';

// ── McpEdge ────────────────────────────────────────────────────────────────────

export class McpEdge implements Service {
  readonly name = 'edge-mcp';
  private httpServer: http.Server | null = null;
  private bus!: Bus;
  private config!: AppConfig;

  async init(bus: Bus): Promise<void> {
    this.bus = bus;
    this.config = await bus.call<AppConfig>('config.get', {});
    await this.start();
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  private httpHost(): string {
    return this.config.mcp.host ?? '127.0.0.1';
  }

  private httpPort(): number {
    const envPort = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : undefined;
    return envPort ?? this.config.mcp.port ?? 9001;
  }

  /** Path prefix for Streamable HTTP, always starts with / */
  private httpEndpointPath(): string {
    const ep = this.config.mcp.endpoint ?? '/mcp';
    return ep.startsWith('/') ? ep : `/${ep}`;
  }

  async start(): Promise<void> {
    const bt = this.config.mcp.bearerToken;
    if (!bt) {
      const addr = `${this.httpHost()}:${this.httpPort()}${this.httpEndpointPath()}`;
      log.warn('╔══════════════════════════════════════════════════════════════╗');
      log.warn('║  MCP server has NO bearerToken configured!                ║');
      log.warn('║  Set mcp.bearerToken in config.json to secure the API.    ║');
      log.warn(`║  Listening on ${addr.padEnd(44)}║`);
      log.warn('╚══════════════════════════════════════════════════════════════╝');
    }
    await this.startHttp(bt ?? null);
  }

  async stop(): Promise<void> {
    await this.stopHttp();
  }

  async startStdio(): Promise<void> {
    const server = this.newServer();
    await server.connect(new StdioServerTransport());
  }

  /** Fresh SDK server with bus-backed handlers — one per HTTP request, or one for stdio. */
  private newServer(): Server {
    const server = new Server(
      { name: 'vargos', version: VERSION },
      { capabilities: { tools: {} } },
    );
    this.setupHandlers(server);
    return server;
  }

  // ── HTTP transport ─────────────────────────────────────────────────────────

  private async startHttp(bearerToken: string | null): Promise<void> {
    const expectedHash = bearerToken
      ? createHash('sha256').update(`Bearer ${bearerToken}`).digest()
      : null;

    this.httpServer = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, Authorization, CF-Access-Client-Id, CF-Access-Client-Secret');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // Bearer token auth (only enforced when a token is configured)
      if (expectedHash) {
        const auth     = req.headers.authorization ?? '';
        const authHash = createHash('sha256').update(auth).digest();
        if (!timingSafeEqual(authHash, expectedHash)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

      if (req.url === '/openapi.json' && req.method === 'GET') {
        this.buildOpenApiSpec().then(spec => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(spec, null, 2));
        }).catch(err => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: toMessage(err) }));
        });
        return;
      }

      if (!req.url?.startsWith(this.httpEndpointPath())) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      // Stateless: this request owns its server + transport, torn down when the response closes.
      const server = this.newServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });

      let label = 'unknown';
      try {
        let parsed: unknown;
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: invalid JSON body' }, id: null }));
            return;
          }
        }

        const method = typeof parsed === 'object' && parsed !== null ? (parsed as { method?: unknown }).method : undefined;
        label = typeof method === 'string' ? method : 'unknown';
        await server.connect(transport);
        await transport.handleRequest(req, res, parsed);
        log.debug(`mcp ${req.method} ${label} → ${res.statusCode}`);
      } catch (err) {
        log.error(`mcp ${req.method} ${label} failed: ${toMessage(err)}`);
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      }
    });

    const host = this.httpHost();
    const port = this.httpPort();
    return new Promise((resolve) => {
      this.httpServer!.listen(port, host, () => {
        log.info(`MCP server listening on ${host}:${port}${this.httpEndpointPath()}${bearerToken ? ' (auth enabled)' : ' (no auth)'}`);
        resolve();
      });
    });
  }

  private stopHttp(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.httpServer) return resolve();
      this.httpServer.close(() => resolve());
      this.httpServer = null;
    });
  }

  // ── MCP handlers ───────────────────────────────────────────────────────────

  private setupHandlers(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: this.bus.list().filter(m => !m.internal).map(m => ({
          name:        m.name,
          description: m.description,
          inputSchema: (m.schema ?? {}) as Record<string, unknown>,
        })),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;

      if (!this.bus.has(name)) {
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }

      try {
        const result = await this.bus.call(name, args);
        // Convert result to MCP format
        const resultText = result && typeof result === 'object' ? JSON.stringify(result) : String(result);
        return { content: [{ type: 'text', text: resultText }], isError: false };
      } catch (err) {
        return {
          content: [{ type: 'text', text: toMessage(err) }],
          isError: true,
        };
      }
    });
  }

  private async buildOpenApiSpec(): Promise<Record<string, unknown>> {
    const tools = this.bus.list().filter(m => !m.internal);
    const paths: Record<string, unknown> = {};

    for (const m of tools) {
      paths[`/tools/${m.name}`] = {
        post: {
          operationId: m.name,
          summary:     m.description,
          requestBody: {
            required: true,
            content: { 'application/json': { schema: m.schema ?? {} } },
          },
          responses: {
            '200': {
              description: 'Tool result',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ToolResult' },
                },
              },
            },
          },
        },
      };
    }

    return {
      openapi: '3.1.0',
      info:    { title: 'Vargos', version: VERSION, description: 'Vargos agent OS tool API' },
      paths,
      components: {
        schemas: {
          ToolResult: {
            type: 'object',
            required: ['content'],
            properties: {
              content: {
                type: 'array',
                items: { type: 'object' },
              },
            },
          },
        },
      },
    };
  }
}

export function createService(): Service {
  return new McpEdge();
}
