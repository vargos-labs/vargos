# CLI Reference

`vargos <service> <method> [args]` — every method is a projection of the bus registry
(see [architecture](./architecture.md)). The CLI proxies to a running daemon on `:9000`;
if none answers it boots a **local stack** (config + the one service), runs the call, and
disposes.

**Live methods require the daemon.** Methods that act on live subsystems (channels, agent
session state, background runs) are tagged `live` in the registry. Without a daemon the CLI
refuses them with `Start it first: vargos start` instead of spinning up a throwaway stack that
would be torn down before the work completes. Everything else (reads + disk writes) runs fine
one-shot.

## Built-in commands (not registry methods)

| Command | Behavior |
|---|---|
| `vargos setup` | The one folded first-run command: seed → migrate → provider setup → environment check → (fresh only) offer channels + MCP. Idempotent; safe to re-run. |
| `vargos` | Runs `setup` automatically when the install isn't ready; otherwise prints usage. |
| `vargos start` | Boot the daemon: bus + all services + JSON-RPC `:9000`. Runs `setup` first *only* when unconfigured (fresh / empty); a normal restart boots straight through. Long-running. |
| `vargos config` | Interactive editor — change provider/model, add a channel, install the MCP adapter, re-check the environment, run pending migrations. `vargos config show` (or `get`) prints the merged config as JSON. |
| `vargos chat` | Hand off to the pi coding-agent REPL bound to `~/.vargos/agent`. The interactive way to talk to the agent. |
| `vargos sync` | Diff bundled `.templates/` against `~/.vargos/`, prompt to overwrite. |
| `vargos --version` / `-v` | Print version. |
| `vargos --help` / `-h` | Usage + live service overview. |

Data migrations run automatically on every boot (silent when there's nothing pending);
environment prerequisites (uv, Playwright browsers) are checked during the first-run
journey and reported advisory-only on `vargos start` / `vargos chat`.

## Registry methods

**Mode** — behavior when **no daemon** is running:
- 🟢 **local** — runs correctly in the one-shot local stack (read-only or disk write the daemon
  later applies).
- 🔴 **live** — refused without a daemon (`vargos start` first).

| Method | Args | Returns | Mode |
|---|---|---|---|
| `agent execute` | `<task>` `[--cwd] [--model] [--sessionKey]` | `{response}` | 🟢¹ |
| `agent status` | `[sessionKey]` | session inventory | 🔴 |
| `channel send` | `<sessionKey> <text>` `[--fromSessionKey]` | `{sent}` | 🔴 |
| `channel sendMedia` | `<sessionKey> <filePath> <mimeType>` `[--caption]` | `{sent}` | 🔴 |
| `channel list` | `[query]` `[--page] [--limit]` | adapters | 🔴 |
| `channel get` | `<id>` | adapter status | 🔴 |
| `channel register` | `<type> <id>` `[--enabled --model --debounceMs --allowFrom --cwd --botToken --persist]` | `{id,type,started,persisted}` | 🔴 |
| `config get` | — | merged config | 🟢 |
| `config set` | (whole object) | config | — (internal) |
| `cron list` | `[query]` `[--page] [--limit]` | tasks | 🟢 |
| `cron add` | `<name> <schedule> <task>` `[--notify]` | CronTask | 🟢 (persist) |
| `cron remove` | `<id>` | `{removed,id}` | 🟢 (persist) |
| `cron update` | `<id>` `[--name --schedule --task --enabled --notify]` | CronTask | 🟢 (persist) |
| `cron run` | `<id>` | `{started,id}` | 🔴 |
| `log search` | `[service]` `[--sinceMs --level]` | entries | 🟢 |
| `media transcribeAudio` | `<filePath>` | `{text}` | 🟢 |
| `media describeImage` | `<filePath>` | `{description}` | 🟢 |
| `media extractDocument` | `<filePath> <mimeType>` | `{text}` | 🟢 |
| `memory search` | `<query>` `[--maxResults --minScore]` | results | 🟢 |
| `memory read` | `<path>` `[--from --lines]` | file content | 🟢 |
| `memory write` | `<path> <content>` `[--mode]` | write ack | 🟢 |
| `memory stats` | — | index stats | 🟢 |
| `web fetch` | `<url>` | `{text}` | 🟢 |
| `webhook list` | `[query]` `[--page] [--limit]` | endpoints | 🟢 |
| `mcp <server>.<tool>` | (tool schema) | tool result | —² |

¹ `agent execute` completes synchronously, so it runs locally. A bare call defaults to the
  shared `cli:adhoc` session; pass `--sessionKey` to scope it. For interactive use prefer `vargos chat`.
² `mcp.*` tools are registered dynamically only after a daemon loads the external MCP servers, so
  they don't exist in a local stack at all (not "refused" — simply absent).

### `channel pair <id> [--reset]` (special subcommand)

Not a registry method — interactive WhatsApp QR pairing that must run **locally** (renders the QR
in your terminal) and **bypass the daemon**, the opposite of how registry methods proxy to `:9000`.
It writes creds to `~/.vargos/channels/<id>/`; `--reset` clears stale/logged-out creds first. Stop
the daemon while pairing so it doesn't hold the session, then `vargos start`. The daemon itself
never pairs: on a QR/logout at runtime it logs `run: vargos channel pair <id> --reset` and stops
(no reconnect loop).

## CLI design principles

These are the rules the surface is held to (enforced by the `live`/`internal` registry flags):

1. **Live methods require a daemon.** If a method's work outlives the synchronous call
   (live channel I/O, session state, fire-and-forget runs), tag it `live`. The CLI refuses it
   without a daemon rather than booting-and-disposing a stack that can't finish the job. The
   local stack is for reads and disk writes only.
2. **Never start a subsystem you'll immediately kill.** One-shot mode (`VARGOS_CLI_ONESHOT`)
   makes service `init` skip live startup (channel adapters, webhook HTTP) — the registry is
   still introspectable, but nothing connects.
3. **Every mutation returns an explicit ack** (the affected record or `{ok/removed/started …}`),
   never a silent `(no result)`.
4. **Consistent vocabulary:** `list` = dump (`[query]` filter + pagination via `ListSchema`),
   `get <id>` = single by id, `search <query>` = ranked query. Mutations: `add` / `update` /
   `remove` / `register`.
5. **Consistent identifiers:** `id` for records/adapters, `sessionKey` for conversation targets.
   Help text must name the real arg (no `<to>` when the field is `sessionKey`).
6. **Positionals for required args, named flags for options** — derived from `cli.positional`.
7. **`internal` hides plumbing** (`config.set`, `agent.appendMessage`, `bus.*`) from the CLI and
   agent surfaces while keeping it callable over RPC.
8. **The registry is the single source of truth** — listings, `--help`, arg shapes, and the
   `live`/`internal` behavior all derive from one `bus.register(...)` per method. Never hand-write
   per-command parsing or a duplicate schema: a missing flag is a schema bug, not a CLI bug. The
   same schema also drives the agent tools and the web console's write actions (see
   [Architecture](./architecture.md)).
