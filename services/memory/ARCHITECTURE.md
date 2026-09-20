# Memory Service Architecture

## Overview

The memory service indexes markdown files and recent session logs into a vector-searchable store. It's the persistent knowledge layer — the agent calls `memory.search` to recall past context and `memory.read` to pull full files.

## Data Flow

```
                    ┌─────────────────┐
                    │  memory.search  │◄──── agent calls via bus
                    │  memory.read    │
                    │  memory.write   │
                    │  memory.stats   │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  MemoryContext  │
                    │  (hybrid search)│
                    └──┬──────────┬───┘
                       │          │
              ┌────────▼──┐  ┌───▼──────────┐
              │  MD files  │  │  Sessions    │
              │  workspace │  │  JSONL logs  │
              └─────┬──────┘  └───┬──────────┘
                    │             │
              ┌─────▼─────────────▼──────┐
              │      chunker.ts          │
              │  (splits into ~400 tok   │
              │   chunks, 80 tok overlap)│
              └────────────┬─────────────┘
                           │
              ┌────────────▼─────────────┐
              │    embedding.ts          │
              │  (OpenAI text-embedding  │
              │   or none — configurable)│
              └────────────┬─────────────┘
                           │
              ┌────────────▼─────────────┐
              │   MemoryStorage          │
              │   (providers/sqlite.ts)  │
              │                          │
              │  tables:                 │
              │   chunks (id, path,      │
              │     content, embedding,  │
              │     metadata)            │
              │   files (path, mtime,    │
              │     size, indexed_at)    │
              └──────────────────────────┘
```

## Indexing Pipeline

### 1. File Discovery (`context.ts`)
- On init and every 5 seconds (debounced sync), globs `**/*.md` from `~/.vargos/workspace/`
- Tracks `mtime` + `size` per file — skips unchanged files
- File watcher picks up live edits (`.md` only)

### 2. Chunking (`chunker.ts`)
- Splits markdown content into ~400 token chunks (~1600 chars) with 80 token (~320 chars) overlap
- Preserves line numbers for citation (`path#L10-L25`)

### 3. Embedding (`embedding.ts`)
- If `embeddingProvider` is `openai`, generates vectors via `text-embedding-3-small`
- If `none`, skips embedding (text-only search)
- Each chunk stored with its vector in SQLite

### 4. Session Indexing (`session-indexer.ts`)
- Finds all `*.jsonl` files in `~/.vargos/sessions/`
- Indexes each message line individually (one chunk per message)
- Tagged with `sessionKey`, `sessionLabel`, `role` in metadata

## Search (`context.ts search()`)

Hybrid scoring: **vector 0.7 + text 0.3**.

1. Generate embedding for the query
2. Vector search: `storage.searchSimilar()` with `minScore` filter (default 0.3), weighted 0.7
3. Text search: term overlap between query and chunk content, weighted 0.3
4. Combined score ≥ `minScore` → included
5. Results sorted by score, capped at `maxResults` (default 6)

Returns: `{ chunk, score, citation }` — citation format: `path#Lstart-Lend`

## Storage Providers

Pattern: `services/memory/providers/` — same factory approach as channels.

### SQLite (`providers/sqlite.ts`) — default
- `better-sqlite3`, single-file DB at `~/.vargos/data/memory.db`
- Tables: `chunks` (id, path, content, start_line, end_line, embedding as JSON, metadata as JSON) + `files` (path, mtime, size, indexed_at)
- No pgvector — no vector search in sqlite. Falls back to in-memory cosine similarity.

### Postgres (`providers/psql.ts`)
- `pg` (node-postgres) + `pgvector` — real `searchSimilar` via cosine `<=>` (HNSW index)
- Tables: `memory_chunks` (embedding as `vector`, metadata as `jsonb`) + `memory_files` — table prefix configurable
- Config: `config.storage.type: "postgres"` + `config.storage.url`. Missing url falls back to sqlite with a warning.
- `searchSimilar` clamps scores to [0,1] to absorb fp jitter. Dimensionless vector columns tolerate mixed dimensions, so after an embedding-model swap the next search degrades to text-only (warn logged) until the old-dim chunks are overwritten by re-sync/reindex.

## Tool Surface

| Method | Params | Description |
|--------|--------|-------------|
| `memory.search` | `query`, `maxResults?`, `minScore?` | Semantic + text hybrid search |
| `memory.read` | `path` (relative to workspace), `from?`, `lines?` | Read a file by path |
| `memory.write` | `path`, `content`, `mode?` | Write/append a file, triggers re-index |
| `memory.reindex` | — | Remove stale chunks for deleted files, re-sync active files |
| `memory.stats` | — | File count, chunk count, last sync time |

## Common Pitfalls

### Paths in `memory.read` must include the subdirectory
Files under `workspace/memory/` must be read as `memory/filename.md`, NOT `filename.md`. The tool resolves paths relative to the workspace root (`~/.vargos/workspace/`), so `2026-07-16.md` resolves to `workspace/2026-07-16.md` (doesn't exist) instead of `workspace/memory/2026-07-16.md`.

### `memory.search` returns workspace-relative paths
Citations like `memory/2026-07-16.md#L5` are correct for `memory.read`. Pass them through as-is.

### Embedding provider is configured in app config, not agent settings
`embeddingProvider` and `openaiApiKey` live on the top-level config (currently not surfaced in the config schema — hardcoded in `MemoryContext` constructor). This is inconsistent with how other services read config.
