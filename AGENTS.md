# Project Instructions

This file provides context for AI assistants working on this project.

## Commands

```bash
pnpm install          # install deps (pnpm workspace: root daemon + web/ console)
pnpm start            # boot gateway + all services + web console (edge/web)
pnpm chat             # Pi SDK CLI bound to ~/.vargos/agent (interactive REPL)
pnpm cli              # run the CLI entrypoint directly (tsx cli.ts)
pnpm seed             # manual `seedDataDir()` — copy missing templates into ~/.vargos/
pnpm run typecheck    # tsc --noEmit (root; `web` is excluded — it has its own)
pnpm run build        # tsc → dist/, then build+stage the web console into dist/web/
pnpm run test:run     # single test run
pnpm lint             # eslint + typecheck
```

The repo is one pnpm workspace: the published root package (`@vargos-labs/vargos`) plus the
private `web/` console (`@vargos-labs/vargos-web`). The **`edge/web` service** brings the console
up as part of the daemon — `vargos start` / `npx` / systemd all serve it:

- Next server (HTTP + `/api/*`) — a child process on `WEB_PORT` (9003). Dev: `next dev`.
  Prod: the Next **standalone** bundle that `pnpm build` stages into `dist/web/`.
- Live-update WebSocket — **in the daemon process**, `VARGOS_WEB_WS_PORT` (9004), so it
  reads gateway state straight off the bus and outlives the Next child.

`web/`'s own source imports shared logic from the daemon (`@vargos/lib/*`), never copies it.
Nothing in `web/` is published — `files` ships only `dist/` (which now includes `dist/web/`).

## Conventions

- **Logging**: `createLogger('service-name')` (no `console.log`).
- **Domain boundaries**: services talk via `bus.call()` / `bus.emit()`; cross-domain imports are blocked by ESLint (`no-restricted-imports`).
- **Config**: `~/.vargos/config.json` + `~/.vargos/agent/{mcp,models,settings,auth}.json`. MCP servers configured in `agent/mcp.json` (shared with Pi SDK); others consolidated by `services/config`.
- **API keys**: provider entries in `agent/models.json`; env `${PROVIDER}_API_KEY` overrides.
- **Skills**: auto-loaded from `~/.vargos/agent/skills/`, `~/.vargos/workspace/skills/`, `<cwd>/skills/`, `<cwd>/.pi/skills/`. Pi SDK injects `name` + `description`; body is read on demand. Bundled: `skill-creator`.
- **Bootstrap files**: only `AGENTS.md`, `SOUL.md`, `TOOLS.md` from workspace + cwd are merged into the system prompt (`services/agent/index.ts:365`). Pi SDK auto-discovers `AGENTS.md` from cwd separately as `# Project Context`.
- **Channel personas**: per-channel system-prompt overrides at `~/.vargos/agents/<channelId>.md`. Frontmatter `allowedTools?: string[]` (glob whitelist applied to bus tools); body appended after bootstrap. `default.md` seeds new channels at boot.
- **Reply or Cross-channel forwarding**: `channel.send` with `fromSessionKey` injects `[fromSessionKey] text` into target session history via `agent.appendMessage` (no agent run on receiver).
- **Slash commands**: not parsed by Vargos — the raw task goes to `session.prompt()` so Pi SDK's extension runner owns them.
- **Interpolation**: `${VAR}` / `${VAR:-default}` in prompts and persona/cron files. Vars: `WORKSPACE_DIR`, `DATA_DIR`, `SESSIONS_DIR`, `CRON_DIR`, `LOGS_DIR`, `CHANNELS_DIR`, `CACHE_DIR`, `HOME`, `PWD`, `CURRENT_DATE`, `CURRENT_TIMEZONE`, `SESSION_KEY`. Source of truth: `services/agent/prompt-interpolate.ts`. Per-message channel vars (`USER_ID`, `CHAT_ID`, `BOT_NAME`, …) were removed with the metadata layer — an unknown `${VAR}` renders literally and logs `interpolation missing keys`.
- **Inference errors surface**: `agent.execute` throws on Pi SDK `stopReason === 'error'`; `agent.onCompleted` emits `{ success: false, error }`.
- **Templates**: `.templates/` recursively seeded into `~/.vargos/` at startup (`lib/templates.ts`); copy-missing only — user edits are always preserved. Use `pnpm seed` for manual reseeding.
- **Frontmatter parser** is generic — `parseFrontmatter<T>(content)` returns `{ meta: T, body }`; empty wrapper `---\n---` is valid.
- **Commit hook** rejects messages containing "Co-Authored-By".

## Service Boot Order

`boot.ts` discovers `services/*/index.<ext>` and loads them: `config` and `log` first (others read config during `init`), then the rest, then the JSON-RPC server, then `bus.onReady`.

`edge/mcp/` and `edge/webhooks/` exist in code but are not auto-discovered (they live in `edge/`). `index.ts` is a tiny supervisor that spawns `boot.ts` as a child and respawns it on exit code 42 — that's how `bus.restartProcess` picks up fresh code from disk without needing systemd.

## Key Patterns

- A service is `services/<name>/index.ts` exporting `createService(): { name, init(bus), dispose() }`. The directory name is the service name and method namespace.
- `init(bus)` registers methods with `bus.register('service.method', { schema, description, cli }, handler)` and listeners with `bus.on('event', fn)`; `dispose()` must release everything it opened (timers, sockets, db).
- Cross-service imports are forbidden. Use `bus.call('service.method', params)` instead.
- Type-only imports from `services/config/` are allowed for type-checking `AppConfig`.

## Workflow

PRs go from a feature branch into `dev`. The maintainer merges `dev` → `main` via squash-only. Status checks (`lint-and-typecheck`, `test`, `codeql`) must pass. Pre-push hook blocks `git push origin main`. Full workflow + ruleset details in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Release Workflow (Maintainer Only)

1. **Bump version** in `package.json`
   ```bash
   # Edit manually or use npm version
   npm version patch  # or minor, major
   ```

2. **Rebuild for distribution**
   ```bash
   pnpm run build
   ```

3. **Update CHANGELOG.md** — Add a new section for the version with:
   - Version number and date (e.g., `## [2.0.14] - 2026-05-16`)
   - Categories: Added, Changed, Fixed, Removed, Security
   - Link to GitHub release at bottom: `[2.0.14]: https://github.com/vargos-labs/vargos/releases/tag/v2.0.14`

4. **Commit and push to main**
   ```bash
   git add package.json dist/ CHANGELOG.md
   git commit -m "chore: bump version to X.Y.Z"
   git push origin main --no-verify
   ```

5. **GitHub Actions publishes automatically**
   - Workflow: `.github/workflows/publish.yml`
   - Publishes to npm as `@vargos-labs/vargos`
   - Creates GitHub Release with tag `vX.Y.Z`

6. **Users get the new version**
   ```bash
   npx @vargos-labs/vargos              # Latest, one-shot
   npm install -g @vargos-labs/vargos   # Global install
   ```

**Note:** External contributors should NOT push directly to `main`. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the PR workflow.
