# Debugging Guide

## Log levels

```bash
LOG_LEVEL=debug pnpm start
```

Levels: `debug`, `info`, `warn`, `error`. At `debug`:

- Every agent run logs `execute: START`, `execute: END`, model in use, tool calls.
- Each session dir gets a `systemPrompt.md`, `customTools.md`, `modelRegistry.json`, `settings.json` dump on creation. Inspect to see exactly what the agent saw.

## Log locations

| Path | Content |
|---|---|
| stdout | Live structured logs (`log.onLog` events) |
| `~/.vargos/logs/errors.jsonl` | Error-level entries only, append-only JSONL |
| `~/.vargos/sessions/<channel>/<chat>/*.jsonl` | Per-prompt session history (Pi SDK format) |
| `~/.vargos/sessions/<channel>/<chat>/systemPrompt.md` | Final assembled system prompt (debug mode only) |

## Inspecting a session

```bash
ls -lat ~/.vargos/sessions/telegram-personal/CHATID/ | head
tail -1 ~/.vargos/sessions/telegram-personal/CHATID/<latest>.jsonl | jq
```

Each line is a `SessionEntry`. Look for:
- `type: "session"` — header (cwd, version, id)
- `type: "model_change"` — what model the session resolved to
- `type: "message"` with `role: "user"` / `"assistant"`
- `stopReason: "error"` + `errorMessage` on assistant messages → the LLM call failed; Vargos surfaces as `agent.onCompleted { success: false, error }`

## Common debug paths

### Agent silent / no reply

1. Tail stdout for `[agent] ERROR` — Vargos surfaces inference errors (Pi SDK `stopReason === 'error'`).
2. Check the latest session JSONL's last assistant message for `errorMessage`.
3. Confirm the model resolved correctly via the session's `model_change` event.

### Channel not receiving

1. Check channel started cleanly: `[telegram-foo] long-polling started` or `[whatsapp-foo] connected as ...`.
2. Telegram groups: bot only fires on `@`-mention or reply.
3. Check `allowFrom` whitelist — rejected senders log `[channels-pipeline] ← <sessionKey> (not whitelisted)` at DEBUG. A whitelisted user in a group who didn't `@`-mention the bot logs `(observing (no @mention))` at INFO.

### Tool not found / not exposed

Open the gateway TCP socket and call `bus.list`:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"bus.list","params":{}}' | nc -q 1 127.0.0.1 9000
```

The agent sees a filtered subset based on the channel persona's `allowedTools` glob — check `~/.vargos/agents/<channelId>.md`.

### Memory search returning nothing

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"memory.stats","params":{}}' | nc -q 1 127.0.0.1 9000
```

The indexer watches `~/.vargos/workspace/**/*.md` and chunks JSONL session files. New writes get indexed within 5s. Default `memory.provider: 'keyword'` uses query-term matching without embedding API calls. Configure embeddings through `vargos config`; see [Memory search](./configuration.md#memory-search).

### `pnpm chat` doesn't see Vargos data

`pnpm chat` execs Pi CLI with `PI_CODING_AGENT_DIR=$VARGOS_DATA_DIR/agent` and `--session-dir $VARGOS_DATA_DIR/sessions/cli`. Confirm with `pnpm chat --list-models | head`.

## Querying the bus

The gateway speaks JSON-RPC 2.0 over TCP — not HTTP. Useful direct calls:

- `bus.list` — list all events
- `bus.list { event: "agent.execute" }` — schema for one event
- `agent.status` — session inventory (state, parent links, model) + active runs
- `memory.stats` — index size

## See also

- [Troubleshooting](./usage.md) — common error fixes
- [Runtime](./usage.md) — execution flow
- [Architecture](./architecture.md) — bus event catalog
