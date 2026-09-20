# Architecture

Vargos is a single **bus** that owns one **registry** of methods. The CLI, the agent's
tools, and the JSON-RPC server are all *projections* of that registry — register a method
once and it appears, identically, on every surface.

Source: [`core/`](../core/) — `bus.ts`, `loader.ts`, `rpc-server.ts`, `cli.ts`, `services.ts`, `types.ts`.

## Methods vs events

| Concept | API | Validated | Surfaced |
|---|---|---|---|
| **Method** | `bus.register(name, opts, handler)` / `bus.call(name, params)` | zod, on every surface | CLI, agent tool, JSON-RPC |
| **Event** | `bus.emit(event, payload)` / `bus.on(event, fn)` | no | internal pub/sub only |

`bus.call('does.not.exist')` throws a structured `MethodNotFoundError` (JSON-RPC `-32601`);
bad params throw `ValidationError` (`-32602`). `bus.emit` with no listeners is a silent no-op.

## Service contract

Each service is `services/<name>/index.ts` exporting `createService(): Service`:

```ts
interface Service {
  name: string;                 // = directory name = method namespace (channel → channel.*)
  init(bus: Bus): Promise<void>; // register methods/handlers, open resources
  dispose(): Promise<void>;      // close sockets, clear timers — MUST fully release
}
```

Services never import each other; all cross-service calls go through `bus.call` / `bus.emit`
(enforced by ESLint `no-restricted-imports`). No module-level mutable state — everything lives
on the instance so it's disposed on reload. The shared data contract is `services/config/schemas`.

A method's registration is the single source of truth:

```ts
bus.register('channel.send', {
  schema: z.object({ recipient: z.string(), message: z.string() }), // validation, all surfaces
  description: 'Send a message via a channel',                       // CLI help + tool description
  cli: { positional: ['recipient', 'message'] },                    // positional arg order
}, (p) => this.send(p));
```

## Discovery and load order

`boot.ts` discovers services by scanning `services/*/index.<ext>` — no manifest; drop a folder
in and it loads. `config` and `log` load first (others read config during `init`); the rest are
sorted. `edge/*/index.<ext>` (external bridges: `edge-mcp`, `edge-webhooks`, `edge-web`) is
discovered the same way but loaded *after* core services, so the bus is fully wired first;
an edge service that fails to load is a warning, not fatal.

## Surfaces

- **CLI** (`vargos`) — `vargos <service>` lists methods, `vargos <service> --help` shows arg
  shapes, `vargos <service> <method> …` invokes. It proxies to a running daemon on `:9000`;
  if none answers, it boots a local stack with only the needed service(s), runs, and disposes.
- **Agent tools** — every non-`internal` method becomes a tool (`bus.list()` in
  [`services/agent/tools.ts`](../services/agent/tools.ts)); persona `allowedTools` filters.
- **JSON-RPC 2.0 over TCP** on `127.0.0.1:9000` (localhost only; API-key auth is a future hook):

  ```bash
  echo '{"jsonrpc":"2.0","method":"memory.search","params":{"query":"..."}}' | nc localhost 9000
  ```
- **Web console** — the [`edge/web`](../edge/web/) service. Loads with the daemon (so
  `vargos start` / `npx` / systemd all serve it), spawns the Next UI as a child on
  `WEB_PORT` (9003) and runs the live-update WebSocket in-process on `VARGOS_WEB_WS_PORT`
  (9004) — the WS reads gateway state straight off the bus. Source lives in
  [`web/`](../web/) (`@vargos-labs/vargos-web`, private); `pnpm build` compiles it to a Next
  standalone bundle staged into `dist/web/`. Degrades to filesystem-only when the gateway
  is still starting.

## Hot reload & supervision

`bus.restart <service>` reloads one service from disk in-process (same PID) via a cache-busting
dynamic import: the loader releases the old instance's methods + listeners, calls `dispose()`,
re-imports, and runs `init()` again — other services keep running and retain state.

`bus.restartProcess` exits with code 42; the supervisor [`index.ts`](../index.ts) respawns
`boot.ts`, reloading all code and transitive deps from disk (`git pull && bus.restartProcess`).

Before the first spawn the supervisor runs `ensureReady()` ([`cli/ready.ts`](../cli/ready.ts)):
seed templates, apply migrations, and — with a TTY — walk provider setup until the install
can serve an agent. No TTY and unconfigured → it prints what's missing and exits non-zero
rather than booting. `vargos` (bare) runs the same gate; post-install edits live in
`vargos config`.

> **Known limitation.** Cache-busting `import('./svc.ts?v=' + Date.now())` leaks the prior
> module generation in memory each reload (ESM has no cache invalidation). `dispose()`
> discipline bounds the *resource* leak (timers, sockets) but not the *module* leak — fine for
> occasional restarts, pathological under hundreds/day. Revisit per-service worker processes if
> reload frequency grows. Acceptance for all of the above is encoded in [`core/__tests__/acceptance.test.ts`](../core/__tests__/acceptance.test.ts).

## Channels

The `channel` service manages messaging adapters (Telegram, WhatsApp/Baileys) behind a common
`ChannelAdapter` contract (`services/channel/types.ts`); `base-adapter.ts` implements the single
shared inbound path, so providers supply only transport hooks. Inbound: adapter → normalize →
pipeline (link-expand, access check) → `agent.execute`. `pipeline.ts` owns in-flight run state and
delivers the reply on `agent.onCompleted`; access rules are pure functions in `access.ts`.
Outbound: `channel.send` → strip markdown → chunk → `adapter.send`.

## See also

- [CLI reference](./cli.md) · [Configuration](./configuration.md) · [Usage](./usage.md) · [Extending](./extending.md)
