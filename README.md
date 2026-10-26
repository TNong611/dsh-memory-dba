# dsh-memory-dba

[中文功能范围说明](README.zh-CN.md)

File-based long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), stored as plain files you can read, diff, and commit.

Session logs answer "what happened in this conversation". This plugin answers "what did we decide three weeks ago" — across sessions, across machines, and across models.

This package is the **file-memory and retrieval plugin** of the wider DBA (Dual-Brain Architecture) project. It is not the complete DBA runtime. The original Python DBA's local RWKV-7 state backend, full two-sided event archive, and durable turn-processing pipeline are not part of this npm package. The scope sections below are the authoritative statement of what you get and what you do not, as of 0.1.2.

```
core.md          injected in full every turn, byte-capped
stream.md        one line per finished turn, retrieved only
ws/<area>.md     detail notes, retrieved only
```

Everything lives in one directory. Copy it, put it in git, point two harness installs at the same folder, or read it with `cat`. There is no database or required embedding service.

## Scope: implemented, not migrated, and not yet accepted

### 1. Implemented in this npm package

| Capability | What this package actually does |
|---|---|
| Three-layer file memory | `core.md`, `stream.md`, `ws/<area>.md` under one directory, plain UTF-8, no database. `init` creates the layout; existing files are never overwritten. |
| Two-section prompt injection | `core` (default order `-50`) and retrieval `hits` (default order `200`) are separate sections. The core layer is re-read on every assembly; the hits section is last so it cannot invalidate the cached prefix above it. |
| BM25 retrieval | BM25 (`k1=1.5`, `b=0.75`) over all three layers. Latin runs stay whole words, CJK runs emit unigrams and bigrams. Recency reranking only reorders candidates that relevance already found, and only when they overflow the byte budget. |
| Optional Ollama / bge-m3 semantic recall | Cosine hits above `minScore` from a `<home>/.vec/embeddings.json` cache are appended after keyword hits without reordering the keyword results. Synchronous 1,500 ms budget (`Atomics.wait` on a worker), 60 s cooldown after a failure, silent degradation to BM25. The cache is built by the CLI, not automatically. |
| DSH session-event integration | Listens on `session/event`: a user-authored `user/message` triggers recall; `assistant/message` text is accumulated for the turn; `turn/end` appends the stream line; `session/disposed` drops the in-memory pending turn. |
| Current stream writing | One line per finished turn: `- YYYY-MM-DD HH:mm | 用户：… | 助手：…`. Whitespace is collapsed, the user side is cut to **300 characters**, the assistant side to **600 characters**, credential-shaped strings are redacted, a line identical to the previous one is skipped, and a turn missing either side is not written. |

### 2. Exists in the original Python DBA, not migrated into this package

| Capability | Original Python DBA | In this package |
|---|---|---|
| RWKV-7 continuous session state and summary backend | `scripts/nb_rwkv.py`, `scripts/nb_rwkv_bridge.py`; `scripts/nb_turn.py` uses the local RWKV backend by default for session recursion, summaries, and branch isolation. | No RWKV backend, no state interface, no summary generation. |
| Full two-sided event archive and event-vector recall | Sanitized complete user/assistant events stored under `.turns/events`, with their own event-level vectors and recall path. | Only a mechanically truncated single stream line per turn; no event archive and no event vectors. |
| Persistent outbox, idempotent receipts, retries | Durable outbox with idempotent event receipts and retry handling. | Only an in-memory `pending` map; a process exit loses the in-progress turn, and a failed write is logged without retry. |
| Message drafts and interrupted-turn recovery | Draft and resume path for interrupted turns. | None. |
| Controlled `core` / `ws` writes | Dedicated `remember_core` / `remember_ws` write paths with their own checks. | CLI `write` appends to `stream.md` only; `core.md` and `ws/*.md` are edited with ordinary file tools. |
| Index-maintenance loop | Chained maintenance for the keyword index, notebook vectors, and event vectors. | BM25 invalidates its corpus cache on file metadata changes; the semantic cache is rebuilt only by a manual `index` run. |

These are real capabilities of the original Python system, not hypothetical future work. Installing this npm package does **not** install them. The plugin does not claim parity with the Python DBA. They may coexist, but concurrent writes to the same memory directory are not coordinated; use one writer per shared directory.

### 3. Research not yet accepted for use in the overall DBA project

| Research item | Actual state |
|---|---|
| Decoding RWKV state into reliable slots or memory codes | State-decoder training experiments were performed on frozen RWKV features, but they did not reach the acceptance standard. The v4 decoder run completed 5,000 steps; on dev (1,779 cases) all-slot exact matches were **0/1779** and content-slot accuracy was 1.6%. The state itself was not useless: true-state token loss 1.185 beat no-state 1.575 and wrong-state 1.260, and per-label linear probes on the same pooled features reached AUC 0.98 — the information is present, the joint multi-label decode is what fails. It was judged **Not qualified** and never entered the final test. There is no usable state-to-slot decoder today. |
| Cross-model consumption of state | Cloud models consume text summaries and retrieved text, not RWKV state tensors or dedicated memory codes. The interface is not built. |
| A genuinely resident service | RWKV runs through a local runner/bridge. Continuity across turns is not the same as an accepted always-on service; no resident deployment has been accepted. |

These items are neither implemented in this package nor accepted upstream. They are research gaps of the whole DBA project, not capabilities that exist somewhere and were merely left out of the npm package.

### Legacy note

The old five-layer architecture's periodic consolidation / retire / dedupe path (`memory_maintenance.py` in the Python tree) is **legacy** in the current DBA and is skipped. It is not a current DBA feature, it was not migrated into this package, and its absence is not a regression or a missing "current" capability.

## Limits and operating notes

Read these before relying on the plugin as shared or historical memory.

- **The retrieval output is a process-wide single slot.** `latestHits` is one variable for the whole plugin instance. The harness passes only a scope key to a prompt section callback, not a session id, so the hits section always renders the most recent user query in the process. Concurrent sessions or same-process subagents are **not isolated**: a later query overwrites the earlier one. An independent audit reproduced this at callback level in a temporary memory directory with the vector path disabled (session A rendered session B's hits). This was not a full host end-to-end concurrency test. The workaround is one agent per process; there is no per-session isolation in 0.1.2.
- **Stream retrieval only covers a recent window.** The index takes at most the most recent **1,000 non-empty stream entries**, within at most **128 KiB** of entry text (an entry larger than 128 KiB is skipped; the scan stops when the byte cap would be exceeded). Older entries remain in `stream.md` but are not in the retrieval candidate set. The 1,000-entry cutoff was exercised in the audit; the 128 KiB cap is enforced in `src/search.mjs` and was **not** independently exercised end-to-end. Move durable facts into `ws/*.md`, which is not capped.
- **The stream is truncated text, not a summary.** The line is a whitespace-collapsed prefix of the original messages (300 characters for the user side, 600 for the assistant side). It is not produced by a local model and does not extract facts; the tail of either message can be lost. This plugin does not keep its own complete event archive; the original Python pipeline provides one separately.
- **Semantic recall needs manual indexing.** The vector cache is not updated by the plugin while it runs. Run `dsh-memory-dba index` after editing memory; documents that are new or changed are still searchable by BM25 but not by semantics until then.
- **An over-budget core is clipped, not compressed.** When `core.md` exceeds `coreLimitKB`, the injected section is cut and marked `[...clipped to fit the memory budget]`. The file itself is not rewritten, summarized, or reorganized.
- **Failed writes are not retried.** A read-only or full disk still serves readable memory, but a failed turn append is logged (`[memory-dba] session event failed: …`) and the turn is lost; there is no outbox or retry queue in this package.
- **The default memory directory is not the old Python DBA directory.** On Windows it is `%LOCALAPPDATA%\dsh-memory-dba`; elsewhere `~/.dsh-memory-dba`, unless `home` or `DSH_MEMORY_HOME` says otherwise. To reuse an existing Python DBA memory library, set `home` explicitly (for example `D:/AI/DBA/memory`).

## Release notes

`0.1.2` through `0.1.4` are documentation-only revisions. No runtime source file or behavior changed in either release; the changes are the scope tables, the limits above, and the corrected release history, so that the npm page matches what is actually delivered. See `CHANGELOG.md` for the full history.

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
| `home` | platform default | Memory directory. `DSH_MEMORY_HOME` overrides the default when `home` is unset. |
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

Core text is reread on each assembly so edits take effect without restarting a session. See the single-slot limitation above for why the hits section is process-wide rather than per-session.

## Retrieval

BM25 over all three layers, tokenized for mixed Chinese/English text: Latin runs stay whole words (so identifiers such as `1234567890` remain searchable), CJK runs emit unigrams and bigrams (a trigram index cannot match a two-character Chinese query).

Ranking is two-step:

1. relevance only — same query, same candidates;
2. if the candidate set exceeds the byte budget, rerank by relevance × recency.

Recency never introduces a candidate that relevance did not find.

Core and stream entries split per non-empty line. Workspace headings and blank lines delimit note blocks; reported line numbers refer to the original files. Workspace additions, edits, removals, and renames invalidate the cached corpus using file names, sizes, and modification times.

For predictable stream retrieval latency, only the most recent **1,000 non-empty stream entries**, within **128 KiB of entry text**, are indexed. Individual entries larger than 128 KiB are skipped. Earlier entries remain on disk but are outside the candidate set; move lasting details into `ws/*.md` to keep them searchable. Core and workspace documents are not capped. A 5 MiB mixed Chinese/English stream is covered by a cold-load-plus-search benchmark test targeting 300 ms; actual timing depends on hardware. Reading and UTF-8 validation still scan the whole stream, so this is not a constant-time guarantee for arbitrarily large files.

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

Useful while tuning `coreLimitKB` and inspecting why a note did or did not surface. The CLI is an operator tool; the plugin does not need it at runtime.

## Writing memory

The plugin appends one line per finished turn:

```text
- 2026-10-26 22:48 | 用户：… | 助手：…
```

Credential-shaped strings (`sk-…`, bearer tokens, long hex runs, long digit runs) are redacted before the line is written, because these files are meant to be committed.

Ordinary separated dates and timestamps (including ISO timestamps) and CJK text are preserved. Unbroken 13–19 digit runs are intentionally redacted, even when they represent epoch milliseconds or compact timestamps. Tags use the same redaction and single-line rules as turn text. This is heuristic redaction, not a guarantee that every secret is removed.

The stream is a timeline, not a transcript. Detail belongs in `ws/<area>.md`, which the model can write with ordinary file tools and retrieval can reach later. There is no controlled `core`/`ws` write command in this package (see scope item 2).

## Degradation

Memory is an enhancement. A missing directory, an unreadable layer, or a corrupt file yields an empty section and never fails a turn. `doctor` reports what is wrong.

Layers are decoded as strict UTF-8: an invalid byte sequence skips that entire layer rather than injecting replacement characters. Healthy layers remain searchable; `doctor` uses strict diagnostics and exits non-zero on unreadable or corrupt layers. A read-only home can still serve readable memory, but failed turn writes are logged and not retried. CLI parse errors, missing commands, and queries with no searchable terms exit non-zero without stack traces.

Cache invalidation is metadata-based, not content-hashed: deliberately preserving both size and modification time can hide an edit. Concurrent writers are not locked; use one writer per memory directory if strict write ordering is required. Permission-error tests simulate filesystem errors for consistent Windows/Linux coverage; the suite does not depend on platform-specific ACL changes.

## License

MIT
