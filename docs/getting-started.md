# Getting Started

## Prerequisites
- Node.js 22.19+
- pnpm

Some MCP servers need tooling that npm won't install for you — `uvx` (from [uv](https://astral.sh/uv))
for Python-packaged servers, downloaded browsers for `@playwright/mcp`. The first-run journey
detects what your configured servers actually need and offers to install it; afterwards it
reports (without prompting) on `vargos start` and `vargos chat`, and you can revisit it from
`vargos config`.

## Install

```bash
git clone https://github.com/vargos-labs/vargos.git
cd vargos
pnpm install
```

## First run

```bash
npx @vargos-labs/vargos        # bare invocation runs the guided journey
# or, from a clone:
pnpm run setup            # the same one command
```

`vargos setup` runs one guided journey and doesn't finish until Vargos can actually run:

1. seed `~/.vargos/` from [`.templates/`](../.templates/) ([`lib/templates.ts`](../lib/templates.ts))
2. apply pending data migrations (silent when there are none)
3. **pick a provider + model, enter the API key** — this one Q&A writes all three files
   (`agent/models.json`, `agent/auth.json`, `agent/settings.json`); a `${PROVIDER}_API_KEY`
   in the environment is picked up automatically
4. check external prerequisites for anything you configured (uv, Playwright browsers)
5. optionally connect a channel or install the MCP adapter — always skippable

Presets: Anthropic, OpenAI, Google, OpenRouter, Groq, DeepSeek, Ollama. Any other
OpenAI-compatible endpoint works — add it later with `vargos config`.

Headless (no TTY) and unconfigured: `vargos setup` / `vargos start` print what's missing
and exit non-zero instead of booting a daemon that can't serve the agent.

## CLI management

```bash
vargos setup           # the guided first-run pass (idempotent)
vargos                 # runs setup if unconfigured, else prints usage
vargos start           # boot the daemon (runs setup first only if config is empty)
vargos config          # change provider/model, add channels, MCP, re-check environment
vargos config show     # print the merged config as JSON
```

## Pi CLI mode

```bash
pnpm chat                     # interactive Pi SDK REPL bound to ~/.vargos/agent
pnpm chat "what's in /tmp?"   # one-shot
```

`pnpm chat` execs `pi` (Pi SDK CLI) with `PI_CODING_AGENT_DIR=$HOME/.vargos/agent` and `--session-dir $HOME/.vargos/sessions/cli`. Sessions land alongside channel/cron sessions and are searchable by the memory indexer.

## Connecting channels

Edit `~/.vargos/config.json` `channels[]` to add Telegram or WhatsApp adapters. See [Channels](./usage.md).

## Manual reseed

```bash
pnpm seed
```

Re-runs the `.templates/` → `~/.vargos/` recursive copy. Copy-missing only — existing files are always preserved.

## What's next

- [Configuration](./configuration.md) — full config reference
- [Channels](./usage.md) — WhatsApp and Telegram setup
- [Personas](./usage.md) — per-channel behavior overrides
- [Runtime](./usage.md) — execution flow
- [MCP](./usage.md) — connect external MCP servers
