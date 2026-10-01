# Changelog

All notable changes to Vargos will be documented in this file.

## [3.4.1] - 2026-10-01

### Fixed
- Bundled skills `nextjs-anti-patterns` and `test-driven-development` shipped unquoted `description` values containing `: `, which is invalid YAML — Pi dropped them and reported a **skill conflict** in `vargos chat`. They now use folded block scalars, and a test validates the frontmatter of every bundled `SKILL.md`.

[3.4.1]: https://github.com/vargos-labs/vargos/releases/tag/v3.4.1

## [3.4.0] - 2026-10-01

### Added
- **Bundled engineering skill library** — 37 generic workflow skills now ship in `.templates/agent/skills/` and seed into `~/.vargos/agent/skills/` on first boot: the `using-agent-skills` router, the phase skills (`spec-driven-development`, `planning-and-task-breakdown`, `incremental-implementation`, `test-driven-development`, `systematic-debugging`, `code-review-and-quality`, `shipping-and-launch`, …), contextual skills (`api-and-interface-design`, `security-and-hardening`, `performance-optimization`, `context-engineering`, `documentation-and-adrs`, `git-workflow-and-versioning`), and Next.js/React pattern packs plus `mcp-builder`.
- `pnpm npx:local` — pack the working tree and run the published bin exactly like `npx @vargos-labs/vargos` (respects the `files` allowlist, fresh dependency tree) for pre-release testing.

### Changed
- **Pi SDK upgraded `0.82.1 → 0.99.2`.** Brings built-in MCP support, the `codemode`/`tool_search` tools, and the `0.84` session-repository migration.
- **Dropped the third-party `pi-mcp-adapter`.** Pi 0.99 ships `builtin:mcp` — enabled by default, reading the same `agent/mcp.json` with the richer `exposure`/`toolExposure` model — so `vargos chat` no longer installs or needs an adapter. Migration `002-remove-mcp-adapter` removes it and translates `directTools` → `exposure` on existing installs.

### Fixed
- **Media extraction no longer overflows the context window.** Document text and audio transcripts are bounded to `agent.media.maxExtractChars` (default 100 000 chars); over-budget text is persisted next to the source and only the head plus a `read`/`grep` pointer is injected, protecting low-context models from a compaction loop.
- Cron: per-task `model` overrides persist across reloads; model specs containing colons resolve correctly; portable `tsx` resolution.
- Media: reject binary files in the document-extraction fallback.

### Removed
- The retired bundled `distill-*` skills are deleted from existing installs by a one-time migration (`.migrations/001-remove-legacy-skills.ts`).
- The `pi-mcp-adapter` lifecycle (`cli/mcp-adapter.ts`, and the "install the MCP adapter" prompts in first-run and `vargos config`) — superseded by Pi's `builtin:mcp`.

[3.4.0]: https://github.com/vargos-labs/vargos/releases/tag/v3.4.0

## [3.2.21] - 2026-09-21

### Changed
- Moved the repository to the [vargos-labs](https://github.com/vargos-labs/vargos) organization and renamed the npm package to `@vargos-labs/vargos` (first release under the new name). Install with `npm install -g @vargos-labs/vargos` or `npx @vargos-labs/vargos`. The old `@chozzz/vargos` package is deprecated and will not receive further updates.

## [3.2.18] - 2026-09-11

### Fixed
- Webhooks: a transform returning an empty string now skips the agent run (and `notify` delivery) instead of firing an empty prompt and delivering the model's reply. `null`/`undefined` skip already worked; the guard now matches the documented `non-empty string` contract. [3.2.18]: https://github.com/chozzz/vargos/releases/tag/v3.2.18

## [3.2.17] - 2026-09-11

### Added
- Webhooks: a transform may now return `null`/`undefined` to skip the agent run (and `notify` delivery) for that event — info-logged as `skipped: <id> — transform returned no task`. Use it for dedup, debounce, or rate-limiting in the transform instead of no-op prompts.

### Fixed
- Webhooks: relative `transform` paths now resolve against `dataDir` and import correctly. Previously the path was validated against `dataDir` but `import()`ed raw, so relative paths always failed to load.

### Changed
- Docs: added webhook transform-module caveats to `docs/configuration.md` (skip signal, body-only/headers unavailable, absolute-path-in-dataDir requirement, module-state lifetime, no interpolation, own logging, steer semantics for concurrent fires).

[3.2.17]: https://github.com/chozzz/vargos/releases/tag/v3.2.17

## [3.2.16] - 2026-09-11

### Changed
- Webhooks: `token` is now optional. When omitted, the hook's `Bearer` auth check is bypassed entirely (any client that can reach the port can fire the hook) and a warning is logged at boot. Hooks with a set token still require `Authorization: Bearer <token>`.
- Docs: refreshed the Webhooks section of `docs/configuration.md` with the field reference and token semantics.

[3.2.16]: https://github.com/chozzz/vargos/releases/tag/v3.2.16

## [3.1.4] - 2026-06-06

### Changed
- Switched license from Apache-2.0 to MIT.

### Fixed
- Handled `EEXIST` error in session creation by gracefully falling back to `continueRecent()`.

[3.1.4]: https://github.com/chozzz/vargos/releases/tag/v3.1.4

## [2.0.3] — 2026-05-08

### Added

- CLI entrypoint (`cli.ts`) with first-run detection and subcommand dispatch.
- Interactive onboarding wizard (`cli/onboard.ts`) for provider, model, and API key setup.
- `vargos` binary now supports `start`, `onboard`, `config`, `--version`, and `--help`.
- Runtime Node.js version guard (requires >= 20).
- Code of Conduct.

### Changed

- `bin` field now points to `dist/cli.js` instead of `dist/index.js`.
- Build script (`pnpm build`) now cleans `dist/` before compiling and copies `.templates/`.
- `pnpm cli` now runs `tsx cli.ts` (local dev entrypoint).

## [2.0.2] and earlier

See git history for changes prior to 2.0.3.
