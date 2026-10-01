# Usage

---

## Runtime

How `agent.execute` runs a turn. Implementation: [`services/agent/index.ts`](../services/agent/index.ts).

### Boot order

```
config → log → web → memory → media → agent → channels → cron → mcp-client → tcp server → bus.onReady
```

Defined in [`index.ts`](../index.ts). `edge/mcp/` (MCP server) and `edge/webhooks/` exist in code but are commented out at boot.

Templates seed first: `seedDataDir(log)` runs before any service boots, recursively copying missing files from [`.templates/`](../.templates/) into `~/.vargos/`. Copy-missing only — user edits are always preserved. See [`lib/templates.ts`](../lib/templates.ts).

### Execution flow

`agent.execute` →
1. `getOrCreateSession(sessionKey, { cwd, model })` — load or create the Pi SDK `AgentSession`
2. `loadPersonaIfChannel(sessionKey)` — channel sessionKeys only
3. `getCustomTools(sessionKey, persona.allowedTools?)` — bus tools, glob-filtered
4. `getSystemPrompt(sessionKey, persona.body?)` — assemble + interpolate
5. `session.prompt(task, { streamingBehavior: 'steer' })` — Pi SDK runs the turn
6. `extractFinalAssistant(session)` — read final message, surface inference errors

Vargos does not pre-parse slash commands: the raw task goes to `session.prompt()` so Pi SDK's
extension runner handles anything it supports (e.g. `/compact`) without double-handling.

Streaming events flow through `subscribeToSessionEvents` → `agent.onDelta` / `agent.onTool` / `agent.onCompleted` on the bus.

### System prompt assembly

In order:

1. **Pi SDK base prompt** — built-in agent instructions.
2. **Pi SDK skills metadata** — `<available_skills>` block (name + description + location only). Skill bodies are read on demand via the `read` tool (Anthropic's progressive-disclosure pattern). Discovery roots: see [Skills](./extending.md).
3. **Pi SDK context files** — auto-walked from `cwd`: `AGENTS.md` per ancestor directory. Rendered as `# Project Context`.
4. **Vargos bootstrap files** — `AGENTS.md`, `SOUL.md`, `TOOLS.md` from `<workspaceDir>` and `<cwd>`. Each head/tail-truncated at 6K chars.
5. **Channel persona body** — content of `~/.vargos/agents/<channelId>.md` (see [Personas](#personas)).
6. **Interpolation** — every `${VAR}` and `${VAR:-default}` replaced. Available variables: paths (`WORKSPACE_DIR`, `DATA_DIR`, etc.), time (`CURRENT_DATE`, `CURRENT_TIMEZONE`), session (`SESSION_KEY`), and documentation placeholders (`PROVIDER`, `VAR`). See [Configuration](./configuration.md#interpolation-variables).

### Tools available to the agent

- **Pi SDK built-ins** (always): `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.
- **Bus tools** — every registered callable across services, wrapped by [`services/agent/tools.ts`](../services/agent/tools.ts).
- **MCP client tools** — external MCP servers from `mcpServers` config, namespaced `mcp.<server>.<tool>`.
- **Persona filter** — channel persona's `allowedTools` glob whitelist filters the bus + MCP list. Built-ins always pass through.

### Session caching

Sessions are cached in-memory by `sessionKey`. They stay alive after `agent_end` for follow-up messages. Pi SDK persists each turn to `~/.vargos/sessions/<sessionKey-with-/>/<timestamp>_<uuid>.jsonl`. On restart, the next call for that sessionKey loads history from disk.

### Inference error surfacing

Pi SDK records LLM call failures (e.g. expired API key) as an assistant message with empty `content` and `stopReason === 'error'` + `errorMessage`. Vargos detects this:
- `agent.execute` **throws** with the underlying error message.
- `agent.onCompleted` emits `success: false, error`.
- Channel pipeline catches and sends `Error: <msg>` back to the user.

### Subagents

`agent.execute` is itself a registered tool. The agent calls it on a child sessionKey (`<parent>:subagent:<child>`) to delegate work. Parent's persona is inherited — `parseSessionKey` strips the `:subagent:` suffix.

### See also

- [Sessions](#sessions) — sessionKey shapes and storage layout
- [Personas](#personas) — per-channel system prompt + tool whitelist
- [API Reference](./architecture.md) — `agent.execute` params + events
- [`services/agent/index.ts`](../services/agent/index.ts) — source of truth

---

## Sessions

A session is one conversation thread. Pi SDK persists every turn to a JSONL file; Vargos caches the in-memory `AgentSession` keyed by sessionKey. Helpers: [`lib/session-key.ts`](../lib/session-key.ts).

### SessionKey formats

| Format | Example | Source |
|---|---|---|
| `<channelId>:<chatId>` | `telegram-personal:7789463749` | Channel adapter |
| `cron:<taskId>:<YYYY-MM-DD>` | `cron:heartbeat:2026-05-06` | `cronSessionKey` |
| `webhook:<hookId>:<ms>` | `webhook:github:1746...` | `webhookSessionKey` |
| `<parent>:subagent:<child>` | `telegram-personal:7789...:subagent:research-1` | Subagent dispatch |

`parseSessionKey` strips the `:subagent:` suffix when present, so a subagent's parsed `type` matches the parent's. This is what lets channel personas and channel-routing work for nested agents automatically.

`parseChannelTarget` splits on the first `:` to get `{ channel, userId }` — used by `channel.send` to find the right adapter.

### Storage layout

Sessions live under `~/.vargos/sessions/<sessionKey-with-/>/` — Vargos converts `:` in sessionKey to path separators when computing the directory (see [`services/agent/index.ts`](../services/agent/index.ts) `getOrCreateSession`). Each prompt creates a new JSONL file in that dir. When `LOG_LEVEL=debug`, the dir also gets `systemPrompt.md`, `customTools.md`, etc.

Examples:
- `~/.vargos/sessions/telegram-personal/7789463749/`
- `~/.vargos/sessions/cron/heartbeat/2026-05-06/`
- `~/.vargos/sessions/cli/` (used by `pnpm chat`)

### Lifecycle

1. **First touch** — `agent.execute` calls `getOrCreateSession`. If not cached, Vargos creates a Pi SDK `AgentSession`, loads any existing JSONL, and caches it.
2. **Each turn** — Pi SDK appends to the JSONL. Streaming events flow through `subscribeToSessionEvents` → bus.
3. **`agent_end`** — `agent.onCompleted` emits with the final response. **The session stays in memory** for follow-ups.
4. **Restart** — in-memory cache is empty after `pnpm start`. Next call for that sessionKey loads from disk.

### Observe-only path

For inbound messages where the agent shouldn't run (whitelist rejection, group chat without bot mention), the channel pipeline consults `shouldExecute()` in [`access.ts`](../services/channel/access.ts). When it returns `false`, the message is recorded into history via `agent.appendMessage` without firing the LLM. No LLM call, no streaming, no `agent.onCompleted`.

### Cross-session injection

When `channel.send` is called with `fromSessionKey`, it sends the outbound text **and** appends `[fromSessionKey] text` to the target session's history (also via `agent.appendMessage`). Used by:

- Cron `notify` delivery
- Webhook `notify` delivery
- Agent forwarding from one channel to another (set `fromSessionKey: ${SESSION_KEY}` per `AGENTS.md` instructions)

Heartbeat is the one cron task that omits `fromSessionKey` — its outputs land in the channel but not in history.

### Memory indexer

[`services/memory/session-indexer.ts`](../services/memory/session-indexer.ts) watches `~/.vargos/sessions/**/*.jsonl` and chunks turns into searchable embeddings. The agent uses `memory.search` to find prior turns across all sessions.

The heartbeat task curates: sessions → daily summaries (`memory/YYYY-MM-DD.md`) → topic files (`memory/<topic>.md`) → `MEMORY.md` index.

### See also

- [Runtime](#runtime) — execution flow
- [Personas](#personas) — per-channel system-prompt overrides
- [API Reference](./architecture.md) — `agent.execute`, `agent.appendMessage`

---

## Channels

Vargos routes messages from WhatsApp and Telegram to the agent runtime. Each channel runs as an adapter inside the gateway process. Configure channels under `channels[]` in `~/.vargos/config.json` — schema in [`services/config/schemas/channels.ts`](../services/config/schemas/channels.ts).

### Telegram

Uses the Bot API directly (no SDK), long-polling, IPv4-forced. Adapter: [`services/channel/providers/telegram/`](../services/channel/providers/telegram/).

**Setup**:
1. Talk to [@BotFather](https://t.me/BotFather), create a bot, copy the token.
2. Add a channel entry to `config.json` with `type: "telegram"`, `id`, `botToken`, `enabled`, optional `allowFrom` (Telegram numeric user IDs — find your own via `@userinfobot`).
3. `pnpm start` — Vargos verifies via `getMe` and starts long-polling.

### WhatsApp

Uses Baileys (linked-devices protocol). Your phone stays primary; Vargos is a linked device. Adapter: [`services/channel/providers/whatsapp/`](../services/channel/providers/whatsapp/).

**Setup**:
1. Add a channel entry with `type: "whatsapp"`, `id`, `enabled`, `allowFrom` (phone numbers, no leading `+`; `@lid` JIDs also accepted).
2. `pnpm start` — a QR code appears.
3. Phone → Settings → Linked Devices → Link a Device → scan.

Auth state is saved per-instance at `~/.vargos/channels/<id>/`. Re-link by deleting that dir and restarting.

### Group chats (Telegram)

Group chats are supported with **mention-only listening**. The bot only runs when:
- Message is in a private chat (DM), **or**
- Bot is `@`-mentioned by username, **or**
- Message is a reply to one of the bot's messages

Non-mentioned group messages are appended to history (so the agent has context if mentioned later) but don't trigger a run. Logic: [`services/channel/providers/telegram/normalizer.ts`](../services/channel/providers/telegram/normalizer.ts).

### Per-channel persona files

Each channel has its own system-prompt overrides at `~/.vargos/agents/<channelId>.md`, auto-seeded at boot. See [Personas](#personas).

### Inbound message fields

Channel adapters normalize each inbound message into `NormalizedInboundMessage` ([`types.ts`](../services/channel/types.ts)): `chatId`, `fromUserId`, `fromUser`, `chatType` (`private` | `group`), `isMentioned`, `messageId`, `mediaKind`, and `text`. The pipeline uses `fromUserId` + `isMentioned` for execution decisions.

In a group `chatId` and `fromUserId` are different values and must not be conflated: replies and reactions go to `chatId` (which becomes the session key), while whitelist checks are about `fromUserId` (the sender).

### Documents and media

| Type | Telegram | WhatsApp |
|---|---|---|
| Images | ✅ vision passthrough | ✅ vision passthrough |
| Voice / audio | ✅ Whisper transcription | ✅ Whisper transcription |
| Documents (PDF/DOCX/XLSX/TXT/MD) | ✅ extracted to text | 🟧 deferred |

Configure transcription/vision providers in `agent/settings.json` `media`. Implementation: [`services/media/`](../services/media/).

Extracted media text (documents and audio transcripts) is capped before it enters the agent's
context — a single over-limit message cannot be summarized away by compaction and pins the
session in an overflow-compaction loop (worst on small-context models, e.g. 110k tokens). When
a document or transcript exceeds the budget the full text is saved next to the source
(`<file>.extracted.txt` / `<file>.transcript.txt`) and only the head is injected, with a pointer
the agent can `read`/`grep` on demand. Tune the ceiling (default `100000` chars ≈ 25k tokens) via
`agent.media.maxExtractChars`; set it lower for small-context models.

### Status reactions

While the agent processes, the bot updates its message reactions: 👀 received → 🤔 thinking → 🔧 tool use → 👍 done / ❗ error. See [`services/channel/status-reactions.ts`](../services/channel/status-reactions.ts).

### Execution decisions

`shouldExecute(allowFrom, userId, chatType, isMentioned)` in [`access.ts`](../services/channel/access.ts) decides whether the agent runs or the message is recorded to history only. Called by [`pipeline.ts`](../services/channel/pipeline.ts) for every inbound message.

| `allowFrom` | Chat type | Mentioned? | Result |
|---|---|---|---|
| omitted / `undefined` | private | — | **Execute** (permissive default) |
| omitted / `undefined` | group | yes | **Execute** |
| omitted / `undefined` | group | no | **Observe** — a group always needs a mention |
| `[]` (empty) | any | any | **Observe** (block all) |
| user whitelisted | private | — | **Execute** |
| user whitelisted | group | yes | **Execute** |
| user whitelisted | group | no | **Observe** |
| user not whitelisted | any | any | **Observe** |

"Observe" means the message is appended to session history via `agent.appendMessage` (so the agent has context later) but no LLM call is made. This applies to both text and media:

- **Text** — appended as-is to history
- **Media** — file is saved to disk, appended to history as a file path only. Vision/transcription/extraction are **skipped** (no API calls). Before paying for enrichment the base adapter asks `shouldEnrich()`, which the channel service wires to the same `shouldExecute()` rule — so the enrichment decision and the execution decision can never disagree.

### Whitelist enforcement

`allowFrom` is checked **before** the agent runs, in the pipeline via [`access.ts`](../services/channel/access.ts). See the [execution decisions table](#execution-decisions) above.

Always set `allowFrom` for production channels — see [`SECURITY.md`](../SECURITY.md).

### Cross-channel forwarding

Cron and webhooks deliver to channels via `channel.send` with `fromSessionKey`, which prefixes `[fromSessionKey] text` and injects into target session history. The receiving agent learns the message came from elsewhere via the prefix convention (taught in `~/.vargos/workspace/AGENTS.md`).

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| QR code doesn't appear (WhatsApp) | Auth state already loaded — wait for `connected` |
| Telegram bot silent | `allowFrom` rejecting sender, or missing API key (check stdout for `[agent] ERROR`) |
| Group chat ignored | Bot wasn't `@`-mentioned or replied-to |
| `Error: No API key for provider: X` in chat | Add API key in `agent/auth.json` or `${PROVIDER}_API_KEY` env |

More: [Troubleshooting](#troubleshooting).

### See also

- [Personas](#personas) — per-channel behavior overrides
- [Configuration](./configuration.md) — `ChannelEntry` schema
- [Sessions](#sessions) — sessionKey formats

---

## MCP

Vargos has two sides to MCP:

- **MCP client** — connects to external MCP servers and exposes their tools to the agent as bus tools. Implementation: [`services/mcp/`](../services/mcp/). **Active.**
- **MCP server** — exposes Vargos's own bus surface as MCP tools to external clients (Claude Desktop, etc.). Implementation: [`edge/mcp/`](../edge/mcp/). **Currently commented out in [`index.ts`](../index.ts).**

### Client (active)

External MCP servers are configured in `~/.vargos/agent/mcp.json` (shared with Pi SDK). This file is seeded with examples on first run.

The file feeds both clients. The daemon registers every tool on the bus (see below); the interactive `vargos chat` uses Pi's built-in `builtin:mcp` (Pi 0.99+), which registers tools as `mcp__<server>__<tool>` and honors the `exposure` / `toolExposure` keys. The daemon ignores those two keys — it exposes all of a server's tools.

At boot, [`services/mcp/`](../services/mcp/) spawns each server, lists its tools, and registers them on the bus namespaced as `mcp.<server>.<tool>`. The agent calls them like any other bus tool. Channel persona `allowedTools` globs apply (e.g. `mcp.atlassian.*`).

If a server fails to start, the gateway logs a warning and continues — it won't block boot.

#### Configuration

```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["@modelcontextprotocol/server-package"],
      "env": { "API_KEY": "${API_KEY}" },
      "enabled": true
    }
  }
}
```

Each server entry supports:
- `command` — executable name (e.g., `npx`, `node`, `python`)
- `args` — array of arguments (optional, or space-separated in `command`)
- `env` — environment variables to pass (optional; merges with process.env)
- `enabled` — set to `false` to skip a server (optional; defaults to `true`)

Configuration schema reference: [`services/config/index.ts`](../services/config/index.ts) (`mcpServers` field).

### Server (disabled at boot)

When re-enabled, the MCP server exposes Vargos's registered methods over HTTP/MCP at `127.0.0.1:9001/mcp` (port and endpoint configurable via the `mcp` config block). Auth uses a bearer token; without it the server doesn't start.

External clients can configure Vargos as an MCP server, e.g. Claude Desktop via `mcp-remote` pointing at the HTTP endpoint. See [examples/mcp-integration.md](./examples.md) when the edge service is re-enabled.

### See also

- [Configuration](./configuration.md) — `mcpServers` and `mcp` schemas
- [API Reference](./architecture.md) — what the MCP server would expose
- [Tools](./extending.md) — how bus methods become tools

---

## Channel Personas

Per-channel system-prompt overrides at `~/.vargos/agents/<channelId>.md`. Implementation: [`services/agent/persona.ts`](../services/agent/persona.ts). Template: [`.templates/agents/default.md`](../.templates/agents/default.md).

### How it works

- At every startup, Vargos enumerates configured channels and ensures `~/.vargos/agents/<channelId>.md` exists. Missing files are seeded from `default.md`.
- When a session is created for a channel sessionKey, the persona is read **fresh from disk** (no in-memory cache) and applied:
  - Body is appended to the merged bootstrap (`AGENTS.md` + `SOUL.md` + `TOOLS.md`) in the system prompt.
  - Frontmatter `allowedTools` glob whitelist filters the bus tools exposed for that session.
- Subagent sessionKeys (`<parent>:subagent:<child>`) inherit the parent's persona — `parseSessionKey` strips the `:subagent:` suffix.
- Cron / CLI / webhook sessionKeys do **not** trigger persona loading.

### Frontmatter

| Field | Type | Effect |
|---|---|---|
| `allowedTools` | `string[]` (glob) | Whitelist of bus tools. Empty/missing = all allowed. Pi SDK built-ins (`read`/`bash`/`edit`/`write`/...) always available. |

Body content is appended verbatim to the system prompt.

### `allowedTools` glob syntax

| Pattern | Matches |
|---|---|
| `memory.*` | `memory.search`, `memory.read`, `memory.write`, `memory.stats` |
| `channel.send` | only `channel.send` (exact) |
| `mcp.atlassian.*` | every tool from the `atlassian` MCP server |
| `*` | all bus tools |

Matcher: [`lib/glob-match.ts`](../lib/glob-match.ts) `matchesGlob`. Filter applied in [`services/agent/index.ts`](../services/agent/index.ts) `getCustomTools`.

### Re-loading

Personas are re-read on every `getOrCreateSession`. Edit the file → next session creation picks it up. Currently-cached sessions keep their loaded persona until eviction or restart.

### Migrating from `instructionsFile`

The old `instructionsFile` channel-config field has been removed. If your `config.json` channels still set it:

1. Move the body of the referenced file into `~/.vargos/agents/<channelId>.md`.
2. Optionally add an `allowedTools` glob list at the top.
3. Remove the `instructionsFile` field from `config.json` (Zod silently strips it).

### See also

- [Channels](#channels) — channel adapter setup
- [Runtime](#runtime) — system prompt assembly order

---

## Workspace Files

Vargos seeds `~/.vargos/workspace/` from [`.templates/workspace/`](../.templates/workspace/) on startup. Files are copied only if they don't already exist — user edits are always preserved. These files shape how the agent behaves, what it remembers, and how it responds.

For how they're injected into the system prompt, see [Runtime](#runtime).

### File reference

| File | Purpose | Injected into prompt? |
|---|---|---|
| **AGENTS.md** | Workspace rules: identity scoping, channel conventions, memory pipeline, boundaries. The agent's operating manual. | ✅ every session |
| **SOUL.md** | Personality, communication style, user profile (`Your Human` block). | ✅ every session |
| **TOOLS.md** | Environment-specific notes: project paths, device names, quick commands. | ✅ every session |
| **HEARTBEAT.md** | Periodic task list for the heartbeat cron. | ❌ read on demand by `~/.vargos/cron/heartbeat.md` |
| **MEMORY.md** | Long-term memory **index** — pointers to `memory/<topic>.md`, not content. Keep <50 lines. | ❌ tool-accessible (`memory.search`, `memory.read`) |

### Memory architecture

```
sessions (raw conversations)
    ↓ heartbeat curates
memory/YYYY-MM-DD.md (daily summaries)
    ↓ heartbeat promotes (>14 days)
memory/<topic>.md (curated topic files)
    ↓ indexed in
MEMORY.md (pointers only)
    ↓ retrieved via
memory.search / memory.read
```

**MEMORY.md is an index, not a store.** Content lives in `memory/<topic>.md`. The heartbeat cron promotes daily notes into topic files and keeps the index lean.

### Heartbeat

The heartbeat task runs as a normal cron task at `~/.vargos/cron/heartbeat.md` (seeded from [`.templates/cron/heartbeat.md`](../.templates/cron/heartbeat.md)). Its prompt body points the agent at `${WORKSPACE_DIR}/HEARTBEAT.md` for the actual checklist.

When the agent finishes its run, replies of exactly `HEARTBEAT_OK` are pruned (no notification sent). Anything else gets delivered to the configured `notify` channels — but not injected into target session history (cron special-cases heartbeat to omit `fromSessionKey`, treating its outputs as ephemeral).

For broader cron behavior, see [Configuration](./configuration.md) and [`services/cron/index.ts`](../services/cron/index.ts).

### Channel personas

Channel-specific behavior overrides live separately at `~/.vargos/agents/<channelId>.md` (not in workspace). See [Personas](#personas). They're the channel-scoped counterpart to workspace bootstrap.

### Skills

Skills are markdown files at `~/.vargos/agent/skills/<name>/SKILL.md` (auto-loaded by Pi SDK) and `~/.vargos/workspace/skills/<name>/SKILL.md` (added by Vargos). See [Skills](./extending.md).

### Key design decisions

- **Only 3 files auto-inject** (AGENTS / SOUL / TOOLS). MEMORY.md and HEARTBEAT.md are tool-accessed.
- **Identity lives in SOUL.md.** Single source of truth.
- **TOOLS.md is environment-specific.** Project paths, devices, conventions.
- **Bootstrap files are truncated at 6K chars** (head/tail strategy in [`services/agent/index.ts`](../services/agent/index.ts)). The agent can `read` full files on demand if needed.

---

## Troubleshooting

### Gateway won't start

**Port already in use** (`EADDRINUSE :::9000`): another process holds 9000. Stop it or change `gateway.port` in `~/.vargos/config.json`.

**Config invalid**: `pnpm start` exits with a Zod validation error pointing at the offending key. Schema reference: [`services/config/index.ts`](../services/config/index.ts).

### Agent silent / sends no reply

Most common cause: the LLM call failed but Pi SDK saved an empty assistant message. Vargos surfaces this as `agent.onCompleted { success: false, error }` and channels send `Error: <message>` back to the user.

Check stdout (or `~/.vargos/logs/`) for an `[agent] ERROR` line. Common errors:

| Error | Fix |
|---|---|
| `No API key for provider: X` | Add API key in `~/.vargos/agent/auth.json` or set `${PROVIDER}_API_KEY` env. |
| `Model not found: X:Y` | `defaultModel` in `agent/settings.json` must match the registry id **exactly**. Pi SDK does exact lookup; mismatch falls through to first-available provider. |
| `Agent execution timeout after 1800000ms` | LLM hung. Check provider status. Default timeout is 30 min. |

If the LLM responds but the message is empty in chat: see `[channels] empty response on success` in stdout. May indicate Pi SDK's `streamingBehavior: 'steer'` interrupted an in-flight prompt with a newer one on the same sessionKey.

### Model resolution

Pi SDK resolves `defaultProvider`+`defaultModel` from `agent/settings.json` via exact `find()`. If wrong, falls through to first available with valid auth. Inspect what loaded:

```bash
head -3 ~/.vargos/sessions/<channel>/<chat>/<latest>.jsonl
```

Look for the `model_change` entry.

### Whitelist / channel rejection

If an inbound message doesn't trigger an agent run, check `allowFrom` on the channel entry. Non-whitelisted senders' messages are appended to history (observe-only path via `shouldExecute()`) but the agent isn't invoked. See [`services/channel/pipeline.ts`](../services/channel/pipeline.ts).

Group chats: bot only runs when @-mentioned or replied-to.

### Empty / stuck responses

| Symptom | Likely cause |
|---|---|
| Bot stays in 🤔 forever | Tool hung mid-call — check `[agent.onTool]` in stdout; restart gateway |
| Heartbeat never delivers | Heartbeat replied `HEARTBEAT_OK` (token pruning skips delivery) — working as designed |
| Model returns no text | Thinking-only or tool-only turn. Rephrase, or set a lower thinking level for the model in `agent/settings.json`. |

### Skill / persona changes don't take effect

- **Personas**: re-read on every `getOrCreateSession`. New sessions for the same channelId pick up edits; cached sessions keep the old persona until eviction or restart.
- **Skills**: Pi SDK reads at session creation. New session sees changes; cached sessions don't.

To force reload: restart the gateway.

### TCP connection failure (external clients)

Gateway listens on `127.0.0.1:9000` over **raw TCP/JSON-RPC** — not HTTP. `curl http://localhost:9000` won't work. Use `nc`:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"bus.list","params":{}}' | nc -q 1 127.0.0.1 9000
```

### Debug logs

```bash
LOG_LEVEL=debug pnpm start
```

Adds verbose logging and writes per-session debug files (`systemPrompt.md`, `customTools.md`, etc.) to each session dir. See [Debugging](./debugging.md).

### See also

- [Debugging](./debugging.md) — log inspection and bus introspection
- [Configuration](./configuration.md) — config schema
