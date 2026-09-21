# Changelog

All notable changes to Vargos will be documented in this file.

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
