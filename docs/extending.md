# Extending Vargos

---

## Tools

In Vargos, **services are tools**. Every method registered with `bus.register` on a service is automatically:

1. Callable over the bus via `bus.call('event.name', params)`
2. Exposed to the agent as a tool (auto-wrapped by [`services/agent/tools.ts`](../services/agent/tools.ts) `createCustomTools`)
3. Reachable from external clients via the TCP gateway and the MCP bridge (when enabled)
4. Callable from the CLI (`vargos <service> <method> …`) — listings, `--help`, and arg shapes derive from the same schema
5. Usable by the web console's write actions (`POST /api/rpc`), which proxy to the gateway

Write a service method, get a tool for free.

> **Single source of truth.** The `schema` you register is authoritative everywhere — CLI flags,
> agent tool input, JSON-RPC validation, and the web console. Import it from
> [`services/config/schemas/`](../services/config/schemas/) instead of re-declaring a `z.object`
> inline; a duplicated schema drifts and silently drops fields on some surfaces (see
> [Architecture](./architecture.md)).

### Anatomy of a service method

The simplest reference is any existing service — read [`services/media/index.ts`](../services/media/index.ts) for a compact one, [`services/cron/index.ts`](../services/cron/index.ts) for multiple methods + scheduled work, or [`services/agent/index.ts`](../services/agent/index.ts) for the most elaborate.

Pattern in short:
- In `init(bus)`, call `bus.register('service.method', { description, schema, cli? }, handler)` (a method + agent tool) or `bus.on('event', fn)` (event listener).
- Reuse the shared schemas from [`services/config/schemas/`](../services/config/schemas/) where one exists — the same definition feeds CLI, agent, RPC, and web.
- The `description` and `schema` (Zod) become the agent's tool definition (and the CLI `--help` text). Write them like documentation for the agent — clear "what it does" and "when to use it".
- Export `createService(): { name, init(bus), dispose() }`. `dispose()` releases everything `init` opened.
- Nothing else: `boot.ts` discovers the folder automatically — no registration list to edit.

### Conventions

- **Services live at** `services/<name>/index.ts` (directory name = method namespace). One `createService()` export per service.
- **Logger**: `createLogger('service-name')` — never `console.log`. Output flows through `log.onLog`.
- **Domain boundaries**: cross-domain imports are blocked by ESLint (`no-restricted-imports`). To call another service, use `bus.call('other.method', params)`.
- **Type-only imports** from `services/config/` are allowed for `AppConfig`.
- **Async**: every registered method should be `async` — `bus.call` returns a Promise.

### What the agent sees

For each registered method, Pi SDK gets a tool with `name`, `description`, and Zod-derived `input_schema`. The agent calls the tool by name; `sessionKey` is auto-injected from the active run.

### Filtering tools per channel

Channel personas (`~/.vargos/agents/<channelId>.md`) carry an `allowedTools` glob whitelist. The agent in that channel sees only matching bus tools. Pi SDK built-ins (`read`/`bash`/...) always pass through. See [Personas](./usage.md).

### External MCP servers

Tools exposed by external MCP servers (configured under `mcpServers` in `~/.vargos/config.json`) are loaded by [`services/mcp/`](../services/mcp/) and namespaced as `mcp.<server>.<tool>`. They behave like any other bus tool — same wrapping, same persona filter applies.

### Pi SDK built-in tools

Filesystem primitives Pi SDK ships, always available regardless of bus tools or persona filters:

| Tool | Description |
|---|---|
| `read` | Read file contents |
| `bash` | Execute shell commands |
| `edit` | String-replace edits in a file |
| `write` | Create / overwrite a file |
| `grep` | Search file contents |
| `find` | Locate files |
| `ls` | List directory |

Pi SDK's `initialActiveToolNames` defaults to `[read, bash, edit, write]` — others are loaded on demand.

### See also

- [Architecture](./architecture.md) — bus registry, service contract, surfaces
- [Usage › Personas](./usage.md) — per-channel tool filtering
- [`core/types.ts`](../core/types.ts) — the `Bus` and `Service` contracts

---

## Skills

Skills are markdown files with YAML frontmatter that the agent loads on demand. Vargos uses Pi SDK's skills format and discovery — there's no Vargos-specific skill schema.

The bundled `skill-creator` skill (at [`.templates/agent/skills/skill-creator/SKILL.md`](../.templates/agent/skills/skill-creator/SKILL.md), seeded into `~/.vargos/agent/skills/`) is the canonical reference. Read it for full guidance on writing effective skills.

### Bundled skill library

Alongside `skill-creator`, `.templates/agent/skills/` ships a generic **engineering-workflow** library, seeded into `~/.vargos/agent/skills/`. [`using-agent-skills`](../.templates/agent/skills/using-agent-skills/SKILL.md) is the router: it maps a task to the right phase skill — spec (`spec-driven-development`), plan (`planning-and-task-breakdown`), implement (`incremental-implementation`), verify (`test-driven-development`, `systematic-debugging`), review (`code-review-and-quality`), ship (`shipping-and-launch`) — plus Next.js/React pattern packs. None are Vargos-specific; delete any you don't want, though note that seeding is copy-missing so a bundled skill you delete reappears on the next boot.

Seeding copies **missing** files only; changed bundled skills are offered for overwrite by `vargos sync` (it never deletes). Retired bundled skills are cleaned up once by a migration in [`.migrations/`](../.migrations/).

### File shape

A skill is a directory containing at minimum `SKILL.md`. Optional siblings: `scripts/` (executables), `references/` (loaded on demand), `assets/` (output templates).

`SKILL.md` frontmatter only needs `name` and `description`. Other fields are ignored by Pi SDK. The description is the trigger — write it to convey both **what the skill does** and **when to use it**.

### Discovery paths

Pi SDK auto-loads skills from:
- `<agentDir>/skills/` — `~/.vargos/agent/skills/` (user-edited + bundled defaults)
- `<cwd>/.pi/skills/` — Pi SDK convention for project-local skills

Vargos's [`services/agent/skills.ts`](../services/agent/skills.ts) `resolveSkillPaths()` adds two more roots via Pi SDK's `additionalSkillPaths`:
- `<workspaceDir>/skills/` — `~/.vargos/workspace/skills/` (user-edited)
- `<cwd>/skills/` — project-local (when channel `cwd` is set)

Pi SDK de-dups by name + realpath. Order of precedence: workspace → agent → cwd → cwd/.pi.

**Bundled skills land under `agent/skills/`**, not `workspace/skills/` — `agent/` is the Pi-SDK-managed layer Vargos owns and ships defaults for; `workspace/` is reserved for user-editable additions.

### How agents use skills

Pi SDK injects an `<available_skills>` block into the system prompt with each skill's `name`, `description`, and `location` — but **not the body**. The agent reads the body via the `read` tool when it decides the skill is relevant. This is Anthropic's progressive-disclosure pattern.

The system prompt also instructs: *"Use the read tool to load a skill's file when the task matches its description."*

### Channel persona `allowedTools` filter

Channel personas can whitelist tools via glob (`memory.*`, `mcp.atlassian.*`). The whitelist filters **bus tools only** — skills (read via the file system) and Pi SDK built-ins (`read`/`bash`/`edit`/`write`/...) are always available.

### Creating a skill

The fastest path: ask the agent to use the bundled `skill-creator`. It guides you through concrete examples → reusable resources → init → editing → iteration.

Or just create `~/.vargos/agent/skills/<name>/SKILL.md` manually.

### See also

- [`.templates/agent/skills/skill-creator/SKILL.md`](../.templates/agent/skills/skill-creator/SKILL.md) — bundled skill-creator
- [Runtime](./usage.md) — system prompt assembly
- [Personas](./usage.md) — channel-scoped tool filtering

---

## Channel Providers

A channel provider is a factory + adapter pair that connects a messaging platform to Vargos. Existing providers under [`services/channel/providers/`](../services/channel/providers/):

- [`telegram/`](../services/channel/providers/telegram/) — Bot API long-polling
- [`whatsapp/`](../services/channel/providers/whatsapp/) — Baileys (linked-devices)

### Contracts

What an adapter must satisfy:

- `ChannelAdapter` interface — [`services/channel/types.ts`](../services/channel/types.ts) — what core calls on your adapter
- `ChannelProvider` factory — same file
- `BaseChannelAdapter` — [`services/channel/base-adapter.ts`](../services/channel/base-adapter.ts) — extend this; it owns the entire inbound path and you supply only transport hooks
- `NormalizedInboundMessage` — what your normalizer must produce

Adapters never see session keys or the whitelist: you work in `chatId`, the base builds
`<instanceId>:<chatId>`, and the pipeline decides who may run the agent.

### What you write

A new provider is typically four files under `providers/<name>/`:

| File | Purpose |
|---|---|
| `adapter.ts` | Extends `BaseChannelAdapter`. Connects, polls/listens, and calls `this.receive(raw)` for every platform event. Implements `start`, `stop`, `normalize`, `sendText(chatId, text)`, `sendTyping(chatId)`, plus optional `resolveMedia`, `sendMedia`, `react`. |
| `normalizer.ts` | Provider-specific message → `NormalizedInboundMessage` |
| `types.ts` | Provider-specific raw types |
| `index.ts` | `ChannelProvider` factory |

Read the telegram provider for the leanest example, whatsapp for the most elaborate (Baileys session, LID mapping).

### Wiring it up

1. Add a discriminated-union member to [`services/config/schemas/channels.ts`](../services/config/schemas/channels.ts) `ChannelEntrySchema` for your provider's config.
2. Add a lazy import to the `PROVIDERS` map at the top of [`services/channel/index.ts`](../services/channel/index.ts) so it's discovered at boot.
3. Restart — the channel service's boot loop ([`services/channel/index.ts`](../services/channel/index.ts)) finds your config entries and instantiates the adapter.

### What you get for free from `BaseChannelAdapter`

- The whole inbound path — `receive()` runs normalize → dedupe → debounce text / flush + resolve media → emit. There is nothing to override, so providers cannot drift from each other
- Session-key construction, and `latestMessageId` tracking for reaction anchoring
- Typing-indicator state machine ([`typing-state.ts`](../services/channel/typing-state.ts))
- Status reactions via [`status-reactions.ts`](../services/channel/status-reactions.ts) — your adapter implements `react()` if the platform supports it
- Inbound media — implement `resolveMedia()` to return the bytes; the base saves the file, decides whether enrichment is worth its cost, and labels the saved path
- Reconnection with backoff via [`Reconnector`](../services/channel/reconnect.ts)
- Per-message dedup ([`dedupe.ts`](../services/channel/dedupe.ts)) and debounce ([`debounce.ts`](../services/channel/debounce.ts))

### Persona files

Channel personas (`~/.vargos/agents/<channelId>.md`) work for any provider — the agent service reads them based on `parseSessionKey(sessionKey).type` matching a configured channel id. No work needed in the adapter. See [Personas](./usage.md).

### See also

- [Channels usage](./usage.md) — config and behavior
- [Channels architecture](./architecture.md) — file map and inbound/outbound flow
- [Bus design](./architecture.md) — how `channel.send` and `agent.appendMessage` interact
