# Configuration

Vargos splits config across **five files** under `~/.vargos/`. The split keeps secrets isolated and aligns with Pi SDK's structure.

| File | Purpose | Schema |
|---|---|---|
| `config.json` | App config: channels, cron, webhooks, gateway | [`services/config/index.ts`](../services/config/index.ts) `AppConfigSchema` |
| `agent/mcp.json` | External MCP servers (shared with Pi SDK) | See [MCP](#mcp) |
| `agent/models.json` | Provider definitions and model registry (Pi SDK owned) | [Pi SDK `ModelRegistry`](../node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts) |
| `agent/settings.json` | Default model, thinking level, media providers | Pi SDK `SettingsManager` |
| `agent/auth.json` | Provider API keys + OAuth tokens | Pi SDK `AuthStorage` |

All four are `0o600` (owner-only). The config service merges them at runtime. Override the data dir: `VARGOS_DATA_DIR=/some/path`.

The `services/config/schemas/*` definitions are the **single source of truth**: they validate CLI,
agent-tool, JSON-RPC, and web calls, and the CLI derives its flags/`--help` from them. Adding a key
to a schema surfaces it on every surface at once — never hand-maintain a per-surface shape.

## Channels

Each entry in `config.json#channels[]` matches [`services/config/schemas/channels.ts`](../services/config/schemas/channels.ts). Keys: `type` (`telegram` | `whatsapp`), `id` (unique instance id, used as sessionKey prefix), `enabled`, `model?` (per-channel override), `cwd?`, `debounceMs?`, `allowFrom?` (whitelist), plus `botToken` for telegram.

The old `instructionsFile` field has been removed — channel system-prompt overrides live in [persona files](./usage.md) at `~/.vargos/agents/<id>.md`.

## Cron tasks

File-based, one task per markdown file at `~/.vargos/cron/<id>.md`. Frontmatter schema:
[`services/config/schemas/cron.ts`](../services/config/schemas/cron.ts) — keys `name`, `schedule`,
`task`, `model?` (`provider:modelId` override), `notify?`, `enabled`, `activeHours?`,
`activeHoursTimezone?`. The same schema validates `cron.add`/`cron.update` over CLI, agent tools,
JSON-RPC, and the web console, and is read back on reload (so overrides survive a restart). Body
is the prompt the agent runs. Notify outputs are sent via `channel.send` with `fromSessionKey` so
target session history records the source.

The bundled `heartbeat` task is the canonical example — see [`.templates/cron/heartbeat.md`](../.templates/cron/heartbeat.md).

## Interpolation variables

Available in any prompt string (cron task body, persona body, system-prompt fragments). Defined in [`services/agent/prompt-interpolate.ts`](../services/agent/prompt-interpolate.ts).

| Group | Variables |
|---|---|
| **Paths** | `${WORKSPACE_DIR}`, `${DATA_DIR}`, `${SESSIONS_DIR}`, `${CRON_DIR}`, `${CACHE_DIR}`, `${LOGS_DIR}`, `${CHANNELS_DIR}`, `${HOME}`, `${PWD}` |
| **Time** | `${CURRENT_DATE}`, `${CURRENT_TIMEZONE}` |
| **Session** | `${SESSION_KEY}` |
| **Documentation placeholders** | `${PROVIDER}`, `${VAR}` (empty — for referencing patterns like `${PROVIDER}_API_KEY`) |

Default-value syntax: `${VAR:-fallback}`. Used when `VAR` is missing or empty.

## Models, providers, auth

`agent/models.json` registers providers and their models for Pi SDK's `ModelRegistry`. `agent/settings.json` sets `defaultProvider` + `defaultModel` (must match the registry id **exactly** — Pi does an exact `find()` and falls through to first-available on miss).

`agent/auth.json` holds API keys and OAuth tokens. Env override: `${PROVIDER}_API_KEY` (e.g. `ANTHROPIC_API_KEY`) takes precedence.

To run Pi CLI against the same config: `pnpm chat` (sets `PI_CODING_AGENT_DIR` and `--session-dir` automatically).

## MCP

External MCP servers are configured in `~/.vargos/agent/mcp.json`, which is shared between Vargos (`pnpm start`) and Pi SDK CLI (`pnpm chat`). See [MCP documentation](./usage.md) for examples and setup.

Tools are namespaced as `mcp.<server>.<tool>` on the bus when the Vargos server is running.

The MCP **server** (Vargos exposing itself as an MCP server) lives in [`edge/mcp/`](../edge/mcp/) and is currently commented out in [`index.ts`](../index.ts).

## Webhooks

Configured under `webhooks[]` in `config.json`. Receiver lives in [`edge/webhooks/`](../edge/webhooks/); inbound flow is `POST /hooks/:id` → auth → transform → agent run → optional `notify` delivery.

| Field | Type | Notes |
|---|---|---|
| `id` | string | URL segment (`/hooks/:id`) and session key (`webhook:<id>:<ms>`) |
| `name` | string | Display name |
| `token` | string | **Optional.** When set, requests must send `Authorization: Bearer <token>` (timing-safe compared). When omitted, auth is bypassed — any client that can reach the port can fire the hook — and the daemon logs a warning at boot. |
| `transform` | string | Optional path to a JS (ESM) transform file |
| `notify` | string[] | Optional session keys to deliver the response to via `channel.send` |

### Transform modules — caveats

A transform module exports a **synchronous** function (`default` or named `transform`) that maps the parsed JSON body to a task prompt string — or `null`/`undefined` to skip the event: `(payload: unknown) => string | null | undefined`. Current limitations, verified against `edge/webhooks/transform.ts` and `edge/webhooks/index.ts`:

- **Skip signal (3.2.17+).** Returning `null` or `undefined` skips `agent.execute` and `notify` delivery for that event (info-logged as `skipped: <id> — transform returned no task`). Use this for dedup, debounce, or rate-limiting. Anything else returned must be a non-empty string — it is used verbatim as the agent task (an `async` transform returning a Promise fails the `z.string()` validation).
- **Body only — no headers.** Only the parsed JSON body is passed to the transform. Request headers (e.g. `X-GitHub-Delivery`) are not available, so any per-event dedup must use a payload hash. Non-JSON bodies are silently parsed as `{}`.
- **`transform` path must resolve inside `dataDir`.** Relative paths are resolved against `dataDir` (e.g. `~/.vargos/`), absolute paths must point inside it (no `~` expansion), and anything else is rejected. Keep the file `.js` (plain ESM) — TS transforms only work when running from source via tsx, not from a published dist build.
- **Module state persists per process, resets on restart.** Loaded transforms are cached (module loaded once, reused for every request), so module-level state (Maps, Sets) survives across events — fine for leading-edge debounces or short-TTL dedup sets. State is lost on daemon restart and on code-reload respawn; design so a worst-case extra fire is acceptable.
- **No config/env interpolation.** `${VAR}` prompt interpolation does not apply to transform files. The module runs inside the daemon process, so `process.env` (daemon-level env vars) and any file under `dataDir` are readable; tunables should be read there or hardcoded.
- **Own logging.** There is no built-in per-event log. Append your own JSONL (e.g. `<dataDir>/webhooks/<hook>.log`) or use `console.log` (daemon stdout). No retention/rotation is provided — manage it yourself.
- **Concurrency: steer semantics.** `agent.execute` prompts the session with `streamingBehavior: 'steer'` — a webhook firing while that hook's run is already in flight is steered *into* the running turn (not a parallel run); both webhook callers then receive the same final assistant response. Coalescing/deduping bursts is still the transform's responsibility if you want each fire to correspond to one run.

## See also

- [Channels](./usage.md)
- [Personas](./usage.md)
- [Architecture](./architecture.md)
