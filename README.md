# dsh-memory-dba

Long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), stored as plain files you can read, diff, and commit.

Session logs answer "what happened in this conversation". This plugin answers "what did we decide three weeks ago" — across sessions, across machines, and across models.

```
core.md          injected in full every turn, byte-capped
stream.md        one line per finished turn, retrieved only
ws/<area>.md     detail notes, retrieved only
```

Everything lives in one directory. Copy it, put it in git, point two harness installs at the same folder, or read it with `cat`. There is no database or required embedding service.

## Install

Install it into the profile directory the harness runs from (`~/.dsh/profiles/<name>/`), so the loader can resolve the package name:

```bash
# from the npm registry
npm install dsh-memory-dba --prefix ~/.dsh/profiles/web

# or straight from GitHub
npm install github:TNong611/dsh-memory-dba --prefix ~/.dsh/profiles/web
```

Then append one entry to the `insert:` list in that profile's `cordis.patch.yml`:

```yaml
- insert:
    # ... existing entries
    - id: memory-dba
      name: dsh-memory-dba
      config:
        home: '~/.dsh-memory-dba'
```

Omit `config` entirely to use the defaults. Restart the harness process after adding the entry; a profile reload is not enough because the prompt sections are registered at startup.

The plugin hooks two prompt sections and the session event stream. Nothing else is required.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `home` | platform default | Memory directory. `DSH_MEMORY_HOME` overrides it. |
| `coreLimitKB` | `15` | Byte cap for the core section. Text past the cap is clipped and marked. |
| `hitBudgetKB` | `6` | Byte cap for the retrieval section. |
| `topK` | `5` | Maximum retrieved notes per turn. |
| `timeDecay` | `true` | When the candidate set overflows the budget, rerank with a recency weight. |
| `halfLifeDays` | `30` | Recency weight halves every N days, floor 0.5. |
| `writeStream` | `true` | Append one line per finished turn to `stream.md`. |
| `tag` | `''` | Optional label written into stream lines. |
| `exclude` | `[]` | Workspace file names to keep out of retrieval, e.g. role-play notes. |
| `coreOrder` | `-50` | Prompt section order for the core layer. |
| `hitsOrder` | `200` | Prompt section order for retrieval hits. |
| `vector.enabled` | `true` | Try optional semantic recall when a cache exists. |
| `vector.url` | `http://127.0.0.1:11434` | Ollama embedding server. |
| `vector.model` | `bge-m3` | Model used for indexing and queries. |
| `vector.timeoutMs` | `1500` | Total synchronous worker-join budget in milliseconds; also caps the embedding request. |
| `vector.minScore` | `0.45` | Cosine floor for an appended semantic hit. |
| `vector.keepAlive` | `30m` | Passed to Ollama so the model stays resident between turns. |

Partial `vector` objects inherit unspecified defaults. Set `vector: { enabled: false }` to disable semantic recall entirely.

## Why two prompt sections

The core layer changes every few days; retrieval hits change every turn. Injecting them as one section would invalidate the cached prompt prefix whenever a hit appears, which costs far more than the memory is worth. The core section sits near the front, the hit section last.

Core text is reread on each assembly so edits take effect without restarting a session. The harness passes only a scope key to a section's text callback, not the session id, so recall text is a single slot: it holds the hits for the most recent user turn in the process. With concurrent sessions (subagents) every prompt renders that last query. Run one agent per process if that matters; there is no per-session isolation.

## Retrieval

BM25 over all three layers, tokenized for mixed Chinese/English text: Latin runs stay whole words (so identifiers such as `202301233055` remain searchable), CJK runs emit unigrams and bigrams (a trigram index cannot match a two-character Chinese query).

Ranking is two-step:

1. relevance only — same query, same candidates;
2. if the candidate set exceeds the byte budget, rerank by relevance × recency.

Recency never introduces a candidate that relevance did not find.

Core and stream entries split per non-empty line. Workspace headings and blank lines delimit note blocks; reported line numbers refer to the original files. Workspace additions, edits, removals, and renames invalidate the cached corpus using file names, sizes, and modification times.

For predictable stream retrieval latency, only the most recent **1,000 non-empty stream entries**, within **128 KiB of entry text**, are indexed. Individual entries larger than 128 KiB are skipped. Earlier entries remain on disk; move lasting details into `ws/*.md` to keep them searchable. Core and workspace documents are not capped. A 5 MiB mixed Chinese/English stream is covered by a cold-load-plus-search benchmark test targeting 300 ms; actual timing depends on hardware. Reading and UTF-8 validation still scan the whole stream, so this is not a constant-time guarantee for arbitrarily large files.

If the first query finds no shared term, recall retries once with CJK unigrams plus Latin words. Existing shared-term hits are never relaxed. The result reports `relaxed: true` only when the retry supplies hits; there are at most two ranking attempts.

## Semantic recall (optional)

BM25 always works on a bare Node install. To add semantic recall, install an Ollama embedding model separately, then build the derived cache:

```bash
ollama pull bge-m3
dsh-memory-dba index --home ./memory --url http://127.0.0.1:11434 --model bge-m3
```

Indexing uses four concurrent requests. Duplicate document texts share one entry (reported as skipped). Rebuild after editing memory; unchanged text still matches, while uncached or changed documents remain searchable by BM25. Indexing refuses with exit code 2 if the embedder is unavailable, without replacing the previous cache. Indexing requests have a separate 30-second timeout so model startup does not consume the recall budget.

The portable `<home>/.vec/embeddings.json` cache stores version, model, dimension, and SHA-1 document-text keys, never document paths. Each vector is quantized to signed int8 with its own `max(abs(vector)) / 127` scale and base64 bytes. `bge-m3` normally uses 1024 dimensions; the cache records the actual model dimension.

On each user message, a lazily reused, unreferenced worker embeds the query using `/api/embed` (falling back once to `/api/embeddings` on HTTP 404), then compares it with cached vectors by cosine similarity. Only document keys are sent, not corpus text. A fresh shared buffer returns at most eight matching corpus indices and scores. The main thread joins synchronously using `Atomics.wait`, with a **1500 ms total budget**, including worker startup and message posting. Prompt section callbacks remain synchronous; no background result mutates a later turn's hits.

Keyword ranking is never rewritten by semantics. Hits above `minScore` that keywords missed are **appended** after the keyword hits, marked `(semantic)`, and cut to a 600-byte excerpt; the prompt budget keeps at most 70% for keyword hits so a long workspace section cannot crowd them out entirely. Fusion of the two rankings was tried and rejected: with no score floor, a semantic table of contents outranked an exact keyword match.

A cold `bge-m3` takes about two seconds to load, longer than the join budget, so the plugin fires one background warmup request when it mounts and asks Ollama to keep the model resident for `keepAlive`. After a failed or timed-out lookup the endpoint is skipped for 60 seconds, which keeps a down or cold embedder from costing the budget on every turn.

Missing caches, unavailable models (including Ollama HTTP 404), network errors, model/dimension mismatches, corrupt caches, and timeouts silently degrade to BM25 during recall. No model is installed automatically. `doctor` reports vector entry counts and corpus coverage; a missing cache is optional even without an embedder, while a corrupt cache fails the vector check. `stats` includes cache bytes when present.

## CLI

```bash
dsh-memory-dba init                     # create the directory and layer files
dsh-memory-dba recall "clock drift"     # what retrieval would return
dsh-memory-dba index                    # build optional semantic cache
dsh-memory-dba write --user "..." --assistant "..."
dsh-memory-dba stats                    # bytes per layer
dsh-memory-dba doctor                   # layout, budget, corpus, retrieval checks
```

Useful while tuning `coreLimitKB` and inspecting why a note did or did not surface.

## Writing memory

The plugin appends one line per finished turn:

```text
- 2026-10-26 22:48 | 用户：… | 助手：…
```

Credential-shaped strings (`sk-…`, bearer tokens, long hex runs, long digit runs) are redacted before the line is written, because these files are meant to be committed.

Ordinary separated dates and timestamps (including ISO timestamps) and CJK text are preserved. Unbroken 13–19 digit runs are intentionally redacted, even when they represent epoch milliseconds or compact timestamps. Tags use the same redaction and single-line rules as turn text. This is heuristic redaction, not a guarantee that every secret is removed.

The stream is a timeline. Detail belongs in `ws/<area>.md`, which the model can write with ordinary file tools and retrieval can reach later.

## Degradation

Memory is an enhancement. A missing directory, an unreadable layer, or a corrupt file yields an empty section and never fails a turn. `doctor` reports what is wrong.

Layers are decoded as strict UTF-8: an invalid byte sequence skips that entire layer rather than injecting replacement characters. Healthy layers remain searchable; `doctor` uses strict diagnostics and exits non-zero on unreadable or corrupt layers. A read-only home can still serve readable memory, but failed turn writes are logged and not retried. CLI parse errors, missing commands, and queries with no searchable terms exit non-zero without stack traces.

Cache invalidation is metadata-based, not content-hashed: deliberately preserving both size and modification time can hide an edit. Concurrent writers are not locked; use one writer per memory directory if strict write ordering is required. Permission-error tests simulate filesystem errors for consistent Windows/Linux coverage; the suite does not depend on platform-specific ACL changes.

## License

MIT
