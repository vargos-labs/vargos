# Vargos Web

Live web console for a running [Vargos](../AGENTS.md) agent OS. Everything on the UI loads
**exactly as Vargos already is** — it reads the live data dir via the filesystem and the
running gateway via JSON-RPC over TCP, and streams changes to the browser over WebSocket.

The console **is part of the daemon** — the [`edge/web`](../edge/web/) service. `vargos
start`, `npx @vargos-labs/vargos` and systemd all bring it up; there is no separate command.
`edge/web` spawns the Next server as a supervised child (**`next dev`** from a clone,
the **standalone bundle** in `dist/web/` in production) and runs the live-update
WebSocket in the daemon process. The `web/` source is a private workspace member
(`@vargos-labs/vargos-web`) that imports shared logic from the daemon (`@vargos/lib/*`)
instead of copying it.

## Ports

The console continues the daemon's `9000` block:

| Port | Service | Override |
| --- | --- | --- |
| 9000 | gateway JSON-RPC | `VARGOS_GATEWAY_PORT` |
| 9001 | `edge/mcp` | `MCP_PORT` |
| 9002 | `edge/webhooks` | `WEBHOOKS_PORT` |
| **9003** | **web console (Next child)** | `WEB_PORT` |
| **9004** | **live-update WebSocket (in daemon)** | `VARGOS_WEB_WS_PORT` (client: `NEXT_PUBLIC_VARGOS_WS_PORT`) |

## What it shows

| Page | Source |
| --- | --- |
| Dashboard | `bus.status`, `agent.status`, `memory.stats` (live RPC) + fs-derived counts |
| Sessions | `~/.vargos/sessions/<channel>/…` JSONL transcripts (fs) |
| Channels | `~/.vargos/config.json` (fs) + `channel.list` (live RPC) |
| Cron | `~/.vargos/cron/*.md` frontmatter (fs) |
| Models | `~/.vargos/agent/models.json` (fs) |
| MCP | `~/.vargos/agent/mcp.json` (fs) |
| Agents | `~/.vargos/agents/*.md` personas (fs) |
| Memory | `~/.vargos/memory.db` via better-sqlite3 read-only (fs) |

## Live updates (WebSocket)

- `edge/web` runs the WebSocket server on **port 9004** *inside the daemon* — so it reads
  gateway state straight off the bus (no RPC self-call) and outlives Next restarts.
- It watches the data dir with `fs.watch` and pushes debounced `fs_change` events.
- It polls the bus every 30s (`bus.status`, `agent.status`, `memory.stats`) and pushes
  `gateway_status` only when the payload changes; new clients get the last snapshot on
  connect.
- The browser connects with exponential-backoff reconnect and refetches the API on any
  live event (`useLiveRefresh`, debounced at 1.5s so an active session's burst of
  `fs_change` events collapses into one refresh).

## Actions (write RPC)

The UI is not read-only — a `/api/rpc` POST proxy talks to the running gateway with a
method allow-list: `bus.restart`, `bus.restartProcess`, `channel.restart`, `channel.send`,
`cron.add`, `cron.update`, `cron.run`, `agent.execute`, `memory.reindex`:

- **Dashboard** — "Run agent task" card (`agent.execute` with model/session-key overrides)
  and per-service **Restart** buttons (`bus.restart`)
- **Cron** — **Run now** per job (`cron.run`)
- **Channels** — **Restart** per channel adapter (`channel.restart`)
- **Memory** — **Reindex** (`memory.reindex`)

## Dark mode

Light/dark toggle in the header; persisted to `localStorage` (`vargos-theme`), defaults to
the OS preference. Applied pre-paint via an inline script to avoid a flash.

## Running

Nothing web-specific to run — start the daemon and the console comes with it:

```bash
pnpm install
pnpm start            # or: vargos start   → daemon + console on :9003
```

From a clone this spawns `next dev` (hot reload). `pnpm build` compiles the console to a
Next standalone bundle in `dist/web/`, which `edge/web` runs in production. Open
**http://localhost:9003**; the sidebar shows a **live** badge once the WebSocket connects.
While the gateway is still starting, pages render from the filesystem and mark it offline.

Iterating on just the UI (no daemon): `pnpm --filter @vargos-labs/vargos-web dev`, then point it
at a running gateway with `VARGOS_GATEWAY_PORT` / `VARGOS_DATA_DIR`.

## Layout

```
../edge/web/index.ts            # the service: supervises the Next child + runs the WS server
web/
├─ next.config.ts               # output: standalone (bundle staged into dist/web/ by the build)
├─ src/server/
│  ├─ paths.ts                  # re-exports @vargos/lib/paths, + the console's agent/* sub-paths
│  ├─ frontmatter.ts           # re-exports @vargos/lib/frontmatter verbatim
│  ├─ rpc.ts                   # JSON-RPC 2.0 over TCP client (newline-delimited, like the gateway)
│  ├─ loaders.ts               # fs loaders: sessions/cron/models/mcp/agents/config/memory.db
│  └─ normalize.ts             # unwraps RPC result shapes (services, channels, agent)
├─ src/lib/
│  ├─ types.ts                 # shared types (sessions, cron, models, mcp, agents, ws events)
│  ├─ api.ts                   # typed fetch helpers for /api/*
│  └─ use-vargos-socket.ts    # browser WS hook + useLiveRefresh
├─ src/app/
│  ├─ page.tsx                 # Dashboard (stats + agent.execute card + service restarts)
│  ├─ sessions/ (list + view)  # transcript viewer for JSONL sessions
│  ├─ channels/  cron/  models/  mcp/  agents/  memory/
│  └─ api/*                    # /api/status, /api/sessions[+transcript], /api/channels,
│                               # /api/cron, /api/models, /api/mcp, /api/agents, /api/memory,
│                               # /api/rpc (write-action proxy with method allow-list)
└─ src/components/
   ├─ app-shell.tsx            # HUD frame: sidebar nav, header, live telemetry, mobile drawer
   ├─ ui/*                     # shadcn primitives (base-nova) — unmodified
   └─ hud/*                    # presentational layer, no vargos logic:
                                #   page-header · panel · stat-tile · status-dot · states · reactor
```

## Design

The look is a dark "holographic console" (light mode is a matching blueprint theme).
It is deliberately **skin-deep** so Vargos changes keep flowing through untouched:

- **One palette.** Every colour is a CSS variable in `src/app/globals.css` (`:root` /
  `.dark`). shadcn components read those variables, so re-theming is a single edit.
- **Thin pages.** Each route still just calls `api.*` and renders — the redesign only
  swapped ad-hoc markup for the shared `src/components/hud/*` primitives. No page owns
  layout chrome, colour, or vargos-specific logic.
- **Shared, not copied.** `src/server/{paths,frontmatter}.ts` import from `@vargos/lib/*`
  (workspace root); the RPC/fs transport in `src/server/*` is otherwise unchanged. The
  live-update WebSocket lives in `edge/web`, not here.
