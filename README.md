# Vargos

**Self-hosted agent OS.** Give any LLM persistent memory, multi-channel presence, tools, scheduling, and sub-agent orchestration — all on your hardware.

## What It Does

- **Any LLM** — Anthropic, OpenAI, Google, OpenRouter, Ollama, LM Studio, Groq, Together, DeepSeek, Mistral, Fireworks, Perplexity
- **Multi-channel presence** — connect WhatsApp and Telegram bots, route messages to the agent
- **Automatic tool discovery** — every service feature becomes available as an agent tool
- **MCP integration** — expose your agent's tools to other applications, connect external tool servers
- **Persistent memory** — vector + keyword search across workspace files and conversation history
- **Scheduled tasks** — run agent tasks on a schedule, send results to channels
- **Webhooks** — trigger agent tasks from external systems (GitHub, monitoring, etc.)
- **Subagent delegation** — agents can spawn child agents for parallel or hierarchical work
- **Media intelligence** — images and audio handled automatically (vision, transcription)

## Quick Start

```bash
# npx (no install)
npx @vargos-labs/vargos

# or clone + run
git clone https://github.com/vargos-labs/vargos.git
cd vargos
pnpm install
pnpm run setup        # guided first run
pnpm start            # boot the daemon + web console
```

First run — `npx @vargos-labs/vargos` (bare), `vargos setup`, or `pnpm run setup` from a clone —
walks one guided journey: seed, migrate, pick a provider + model, enter the key, check
prerequisites. It doesn't finish until the agent can run. One Q&A writes every config file;
a `${PROVIDER}_API_KEY` in the environment is used automatically.

After that: `vargos start` boots the daemon (and re-runs `setup` only if the config is
still empty); `vargos config` changes the provider, adds channels, or installs the MCP
adapter (`vargos config show` prints the merged config).

## Architecture

One **bus** owns one **registry** of methods. The CLI, the agent's tools, and the JSON-RPC
server are all projections of that registry — register a method once, it appears everywhere.

```
        CLI            Agent tools        JSON-RPC :9000
          \                 |                   /
           └──────────  Bus (registry)  ───────┘
                              │
   config · log · web · memory · media · agent · channel · cron · mcp
       (services/<name>/ — discovered from disk, loaded by the bus)
```

Services are isolated — no shared state, no cross-imports; they talk only via `bus.call` /
`bus.emit`. See [Architecture](./docs/architecture.md).

## Key Concepts

- **Agent** — An AI system that reads instructions, sees available tools, and decides what to do to help you
- **Channel** — A messaging platform (WhatsApp, Telegram) where users can talk to the agent
- **System prompt** — Instructions that tell the agent how to behave (merged from `AGENTS.md`, `SOUL.md`, `TOOLS.md` in your workspace + per-channel persona files)
- **Session** — A conversation thread with one user; Vargos remembers previous messages
- **Tool** — A capability the agent can use (read a file, run code, fetch a URL, send a message)
- **Workspace** — Your project folder where Vargos stores instructions, skills, and conversation history

### Message Handling

Messages go through a simple pipeline: **receive → process → execute → respond**. The agent has access to all Vargos tools and your workspace context. See [Usage](./docs/usage.md) for details.

## Documentation

| Doc | Description |
|-----|-------------|
| [Getting Started](./docs/getting-started.md) | Install, first run, config wizard |
| [Configuration](./docs/configuration.md) | Full config reference |
| [Architecture](./docs/architecture.md) | Bus registry, service contract, surfaces, hot reload |
| [Usage](./docs/usage.md) | Channels, sessions, MCP, runtime, personas, workspace files |
| [Extending](./docs/extending.md) | Add tools, skills, providers |
| [Examples](./docs/examples.md) | MCP integration, scheduled research, multi-channel |
| [Debugging](./docs/debugging.md) | Debug modes and logging |
| [Roadmap](./docs/ROADMAP.md) | Planned features |

## Usage

```bash
vargos                 # First-run journey, or usage once configured
vargos start           # Boot the daemon + web console (bus, services, JSON-RPC :9000, UI :9003)
vargos config          # Change provider/model, add channels, MCP, re-check environment
vargos <service>       # List a service's methods (e.g. vargos channel)
vargos <service> --help        # Methods, descriptions, arg shapes
vargos <service> <method> …    # Invoke a method (e.g. vargos channel send <to> "<msg>")
```

## Development

```bash
pnpm install          # Install deps (workspace: daemon + web/ console)
pnpm start            # Boot the daemon + web console (alias: vargos start)
pnpm chat             # Pi SDK interactive REPL bound to ~/.vargos/agent
pnpm cli              # Run the CLI entrypoint directly (tsx cli.ts)
pnpm run test:run     # Tests (single run)
pnpm run typecheck    # TypeScript check
pnpm lint             # ESLint + typecheck
pnpm build            # Compile → dist/ + build the web console into dist/web/
```

The **web console** comes up with the daemon — `vargos start`, `npx @vargos-labs/vargos`, and
systemd all serve it. It's the `edge/web` service: a Next child on **:9003** (HTTP + `/api/*`)
plus a live-update WebSocket on **:9004** that runs inside the daemon. A live read/observe UI
over sessions, channels, cron, models, MCP, agents and memory, with a few write actions
(restart, run cron, dispatch agent). See [`web/README.md`](./web/README.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for architecture and development guidelines.

## License

[MIT](./LICENSE)
