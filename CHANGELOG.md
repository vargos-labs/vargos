# Changelog

All notable changes to Vargos will be documented in this file.

## [3.5.0] - 2026-11-17

### Added
- V2 voice workspace with an orbital reactor, movable detail panels, contextual resource actions, and voice-controlled workspace navigation.
- Packaged Hugging Face speech runtime managed by the Vargos service, with an explicit dependency installer and configuration through the existing RPC gateway.

### Changed
- Shared model, reasoning, tool, and skill options across agent personas, channels, cron tasks, and webhooks.
- Voice connections retain their live conversation across browser reconnects and replay running and recent activity.
- Speech settings remain in agent settings; transport endpoints use the central voice configuration.

### Fixed
- Delegated tool and skill selections cannot widen persona restrictions.
- Failed voice initialization releases cached connections; runtime retries clean up orphaned speech processes.
- Workspace actions reuse resource parameters and shared confirmation dialogs.

[3.5.0]: https://github.com/vargos-labs/vargos/releases/tag/v3.5.0

## [3.4.6] - 2026-11-16

### Added
- Voice console with live transcripts, tool and skill activity, microphone controls, and speech interruption.
- Shared voice agent profile using existing instructions, bus tools, and SDK skill discovery.
- Optional voice configuration in agent settings and a bundled Jarvis reference recording.

### Fixed
- Voice tool calls acknowledge dispatch immediately so conversation can continue while tools run; results and agent progress arrive as updates.
- Voice-dispatched agents default to low reasoning effort while preserving explicit overrides.

[3.4.6]: https://github.com/vargos-labs/vargos/releases/tag/v3.4.6

## [3.4.5] - 2026-11-16

### Added
- MCP progress notifications for agent execution, with completed outward text and tool activity filtered from session events.
- Optional task names for MCP conversation keys and a typed reasoning-effort override for agent execution.

### Fixed
- Imported MCP tools remain available internally without being re-exported through the external MCP gateway.

### Removed
- Unused STS, STT, and TTS services and their experimental web surface. Channel voice-message transcription remains available through the media service.

[3.4.5]: https://github.com/vargos-labs/vargos/releases/tag/v3.4.5

## [3.4.2] - 2026-10-14

### Fixed
- **First boot no longer dies seeding the data dir on a filesystem boundary.** `fs.copyFile` is backed by `copy_file_range(2)`, which returns `EXDEV` when the destination sits on a different filesystem — the case when `~/.vargos` is an NFS mount bind-mounted into an LXC — and the kernel's own fallback then surfaced `EACCES` from `close(2)` on a destination that was plainly writable. `vargos start` aborted on the first bundled template with `EACCES: permission denied, copyfile … -> ~/.vargos/agent/mcp.json`. Seeding (`lib/templates.ts`) and channel-persona creation (`services/agent/persona.ts`) now retry with a plain read+write for the errnos that shape can produce; unrelated errors still propagate unchanged.

[3.4.2]: https://github.com/vargos-labs/vargos/releases/tag/v3.4.2

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
