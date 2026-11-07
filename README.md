# dsh-memory-dba

[中文功能范围说明](README.zh-CN.md) · [记忆操作与数据格式](MEMORY.md)

File-based long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), stored as plain files you can read, diff, and commit.

Session logs answer "what happened in this conversation". This plugin answers "what did we decide three weeks ago" — across sessions, across machines, and across models.

This package is the **file-memory and retrieval plugin** of DBA. Version 0.3.0 adds its own complete sanitized text events, recoverable stream publication, topic cards and versioned facts. The original Python RWKV backend and processing pipeline remain separate; no state model is enabled by this change.

```
core.md          injected in full every turn, byte-capped
stream.md        one line per finished turn, retrieved only
ws/<area>.md     detail notes; retrieval returns the file name only, body on --file
catalog.json     navigation cards and evidence-backed fact revisions
events-v1/       complete sanitized text events, read explicitly by ID
```

Everything lives in one directory. Copy it, put it in git, point two harness installs at the same folder, or read it with `cat`. There is no database or required embedding service.

## Scope: implemented, not migrated, and not yet accepted

### 1. Implemented in this npm package

| Capability | What this package actually does |
|---|---|
| Three-layer file memory | `core.md`, `stream.md`, `ws/<area>.md` under one directory, plain UTF-8, no database. `init` creates the layout; existing files are never overwritten. |
| Split prompt injection | `core` is a system-prompt section (default order `-50`), snapshotted once per session. Retrieval `hits` are runtime context (default order `300`), which the harness materializes as a trailing user snapshot. A hit list inside the system prompt would change the head of the request and invalidate every message behind it. |
| BM25 retrieval | BM25 (`k1=1.5`, `b=0.75`) with CJK unigrams/bigrams. Level 1 searches `stream` text plus **workspace file names, first-line titles and explicit topic-card fields**; `core.md` is injected in full and stays out of the recall corpus, so the same text cannot spend the budget twice (same rule as the Python side). Workspace bodies are not in the corpus at all (see Retrieval). Recency reranking only reorders candidates that relevance already found, and only when they overflow the byte budget. |
| Optional Ollama / bge-m3 semantic recall | Cosine hits above `minScore` from a `<home>/.vec/embeddings.json` cache are appended after keyword hits without reordering the keyword results. Workspace entries in that cache are name-only documents, so a semantic hit cannot bypass level 1 and surface a body. Synchronous 1,500 ms budget (`Atomics.wait` on a worker), 60 s cooldown after a failure, silent degradation to BM25. The cache is built by the CLI, not automatically. |
| DSH session-event integration | Persists text drafts, archives completion before publishing the stream, and recovers completed unpublished events on mount. Interrupted records remain inspectable without replaying them as completed turns. |
| Current stream writing | Bounded head-and-tail excerpts (300/600 characters), with `[event=ID]` pointing to complete sanitized text in `events-v1`. Explicit observation labels are candidates, not automatically verified facts. |
| Cards and facts | `catalog.json` holds explicit workspace navigation and evidence-backed fact revisions. Superseded/retracted records leave default retrieval; unresolved values are marked as conflicts. See [MEMORY.md](MEMORY.md). |

### 2. Exists in the original Python DBA, not migrated into this package

| Capability | Original Python DBA | In this package |
|---|---|---|
| RWKV-7 continuous session state and summary backend | `scripts/nb_rwkv.py`, `scripts/nb_rwkv_bridge.py`; `scripts/nb_turn.py` uses the local RWKV backend by default for session recursion, summaries, and branch isolation. | No RWKV backend, no state interface, no summary generation. |
| Complete events and event-vector recall | Original complete events and vector recall under `.turns`. | Own complete text archive under `events-v1`; no event vectors or old-archive migration. |
| Persistent outbox and retries | Original multi-stage pipeline. | Own durable text drafts and recoverable stream-publication queue; no RWKV processing stages. |
| Message drafts and interrupted turns | Original resume pipeline. | Text drafts persist; interrupted dialogue is not automatically resumed. |
| Controlled `core` / `ws` writes | Dedicated `remember_core` / `remember_ws` write paths with their own checks. | CLI `write` appends to `stream.md` only; `core.md` and `ws/*.md` are edited with ordinary file tools. |
| Index-maintenance loop | Chained maintenance for the keyword index, notebook vectors, and event vectors. | BM25 invalidates its corpus cache on file metadata changes; the semantic cache is rebuilt only by a manual `index` run. |

These are real capabilities of the original Python system, not hypothetical future work. Installing this npm package does **not** install them. The plugin does not claim parity with the Python DBA. They may coexist, but concurrent writes to the same memory directory are not coordinated; use one writer per shared directory.

### 3. Research not yet accepted for use in the overall DBA project

Two state interfaces were tried, and neither validates the other:

- **(A) Memory-token prefix.** A frozen RWKV-7 state passes through an adapter into *k* continuous tokens at the LLM hidden width, which are concatenated in front of the instruction embeddings of a frozen Qwen2.5. Only the adapter and the output head train, on downstream task error — no text is produced in between. This is the interface the architecture-judgment experiment tested: best 0.5477 against a direct-MLP baseline of 0.6774 on 50 sealed test episodes, and the ablation (correct vs wrong-episode vs zero vs random tokens) shows the tokens carry episode-specific information. It is not yet accepted either: the rank among token counts is unsettled, the 64-token seeds are incomplete, and on a small 192k-sample budget memory tokens still trail the MLP baseline — they overtake only after enough training data.
- **(B) State-to-text slot decoding.** A decoder turns the state into four readable slots and the text is fed onward. All six rounds failed acceptance (best 9/1773 all-slot exact). **Every `0/1779` figure on this page belongs to (B) only and says nothing about (A).**

What the DBA runtime actually uses today is a third path: text summaries plus retrieval. It is neither (A) nor (B).

| Research item | Actual state |
|---|---|
| Decoding RWKV state into readable text slots (route B) | State-decoder training experiments were performed on frozen RWKV features, but they did not reach the acceptance standard. The v4 decoder run completed 5,000 steps; on dev (1,779 cases) all-slot exact matches were **0/1779** and content-slot accuracy was 1.6%. The state itself was not useless: true-state token loss 1.185 beat no-state 1.575 and wrong-state 1.260, and per-label linear probes on the same pooled features reached AUC 0.98 — the information is present, the joint multi-label decode is what fails. It was judged **Not qualified** and never entered the final test. There is no usable state-to-text decoder today. |
| Cross-model consumption of state | Cloud models consume text summaries and retrieved text, not RWKV state tensors or dedicated memory codes. The interface is not built. |
| A genuinely resident service | RWKV runs through a local runner/bridge. Continuity across turns is not the same as an accepted always-on service; no resident deployment has been accepted. |

These items are neither implemented in this package nor accepted upstream. They are research gaps of the whole DBA project, not capabilities that exist somewhere and were merely left out of the npm package.

### Legacy note

The old five-layer architecture's periodic consolidation / retire / dedupe path (`memory_maintenance.py` in the Python tree) is **legacy** in the current DBA and is skipped. It is not a current DBA feature, it was not migrated into this package, and its absence is not a regression or a missing "current" capability.

## Limits and operating notes

Read these before relying on the plugin as shared or historical memory.

- **Workspace bodies are not retrievable from this package.** Level 1 returns file names only by design. The second-level read is the Python DBA CLI (`scripts/nb_search.py --file <区名>`), which the hits block names using `<home>/../scripts/nb_search.py` (derived from `home`; override with `detailHint`); an install that does not have the DBA tree can still recall names, but there is no in-plugin command that expands a body. This is a deliberate boundary, not a missing index.
- **Retrieval text and core snapshots are per-session.** `user/message` stores the hits under `session.id`, and `memory-dba:hits` resolves them with `context.agent.id`; `memory-dba:core` snapshots per `context.agent.id` as well. Two live sessions therefore no longer overwrite each other. Contexts without an agent id (diagnostics, tests, non-agent assembly) cannot be isolated: hits fall back to the latest single slot, and core rereads on every assembly while keeping only a last-read slot. Disposing a session clears its hits and core snapshot; live core snapshots remain until disposal, so memory scales with the number and size of active sessions.
- **Stream retrieval only covers a recent window.** The index takes at most the most recent **1,000 non-empty stream entries**, within at most **128 KiB** of entry text (an entry larger than 128 KiB is skipped; the scan stops when the byte cap would be exceeded). Older entries remain in `stream.md` but are not in the retrieval candidate set. The 1,000-entry cutoff was exercised in the audit; the 128 KiB cap is enforced in `src/search.mjs` and was **not** independently exercised end-to-end. Move durable facts into `ws/*.md`, which is not capped and is read on demand through the `--file` second pass.
- **Excerpts are navigation, not semantic summaries.** Full sanitized text is retained in `events-v1`; labelled observations remain candidates. Add facts explicitly with evidence. Old truncated text cannot be reconstructed.
- **Semantic recall needs manual indexing.** The vector cache is not updated by the plugin while it runs. Run `dsh-memory-dba index` after editing memory; documents that are new or changed are still searchable by BM25 but not by semantics until then.
- **An over-budget core is clipped, not compressed.** When `core.md` exceeds `coreLimitKB`, the injected section is cut and marked `[...clipped to fit the memory budget]`. The file itself is not rewritten, summarized, or reorganized.
- **Recovery requires archival storage.** Completed archived events with failed stream publication are retried on mount. Archive write failure is logged and readable recall remains available. Keep one active writing host per memory directory.
- **The default memory directory is not the old Python DBA directory.** On Windows it is `%LOCALAPPDATA%\dsh-memory-dba`; elsewhere `~/.dsh-memory-dba`, unless `home` or `DSH_MEMORY_HOME` says otherwise. To reuse an existing Python DBA memory library, set `home` explicitly (for example `D:/AI/DBA/memory`).

## Release notes

`0.3.0` adds complete text archives, explicit navigation cards, evidence-backed fact corrections and Python content-manifest freshness checks. See [MEMORY.md](MEMORY.md). Vector recall stays opt-in.

`0.2.2` makes retrieval state match the harness's session model. `core.md` is snapshotted per session (`coreRefresh: 'session'`, or `'always'` to opt out), retrieval hits are keyed by session id instead of one process-wide slot, and an empty recall contributes a cold-path hint naming the Python index (`coldHint`, `'off'` to disable). Semantic recall is now **off by default** (`vector.enabled: false`) because the name-only level-1 corpus gave it 0/143 useful non-core coverage while costing up to 1500 ms and a GPU; set it to `true` to opt back in. See `CHANGELOG.md`.

`0.2.1` keeps `core.md` out of the recall corpus. Core is still injected in full as a system-prompt section, but retrieval no longer indexes it, so the same text cannot consume the prompt budget twice; this matches the Python DBA side, which excludes `core` by default. See `CHANGELOG.md`.

`0.2.0` changes retrieval behavior: workspace layers are indexed as names plus first-line titles and rendered without bodies; the body read moves to an explicit `--file` second pass in the Python DBA CLI. See `CHANGELOG.md`.

`0.1.2` through `0.1.5` are documentation-only revisions. No runtime source file or behavior changed in either release; the changes are the scope tables, the limits above, and the corrected release history, so that the npm page matches what is actually delivered. See `CHANGELOG.md` for the full history.

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

Omit `config` entirely to use the defaults. Restart the harness process after adding the entry; a profile reload is not enough because the prompt section and runtime context are registered at startup.

The plugin hooks one prompt section, one runtime context, and the session event stream. Nothing else is required.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `home` | platform default | Memory directory. `DSH_MEMORY_HOME` overrides the default when `home` is unset. |
| `coreLimitKB` | `15` | Byte cap for the core section. Text past the cap is clipped and marked. |
| `hitBudgetKB` | `6` | Byte cap for the retrieval runtime context. |
| `topK` | `5` | Maximum retrieved notes per turn. |
| `timeDecay` | `true` | When the candidate set overflows the budget, rerank with a recency weight. |
| `halfLifeDays` | `30` | Recency weight halves every N days, floor 0.5. |
| `writeStream` | `true` | Append one line per finished turn to `stream.md`. |
| `tag` | `''` | Optional label written into stream lines. |
| `exclude` | `[]` | Workspace file names kept out of retrieval entirely, e.g. role-play notes. Extra guardrail only: the real gate is that level 1 indexes workspace names, never bodies. Matches by file name, so a rename requires updating this list; the Python DBA's `nb_doctor` flags an entry that no longer exists. |
| `detailHint` | `''` | Full text of the level-1 workspace hint. Empty derives `py -3.14 <home>/../scripts/nb_search.py "查询" --file <区名>` from `home`; a non-empty value is used verbatim (non-Windows installs, another Python launcher). |
| `coldHint` | `''` | Text contributed when level-1 recall has no hits. Empty derives a sentence naming the full Python index; `'off'` (or an explicit empty value/`false`) disables it. A non-empty string replaces the whole sentence. |
| `coreRefresh` | `'session'` | `'session'` snapshots `core.md` on the first assembly of each session so the cacheable head stays stable; `'always'` re-reads on every assembly when edits must apply immediately. |
| `coreOrder` | `-50` | System-prompt section order for the core layer. |
| `hitsOrder` | `300` | Runtime-context order for retrieval hits; the harness's own contexts use 100–210. |
| `vector.enabled` | `false` | Optional semantic recall. Off by default: level 1 is already name-only, and the synchronous worker measured 0/143 non-core coverage against a 1500 ms/GPU cost. Set `true` and build the cache to opt in. |
| `vector.url` | `http://127.0.0.1:11434` | Ollama embedding server. |
| `vector.model` | `bge-m3` | Model used for indexing and queries. |
| `vector.timeoutMs` | `1500` | Total synchronous worker-join budget in milliseconds; also caps the embedding request. |
| `vector.minScore` | `0.45` | Cosine floor for an appended semantic hit. |
| `vector.keepAlive` | `30m` | Passed to Ollama so the model stays resident between turns. |

Partial `vector` objects inherit unspecified defaults. Semantic recall is **off by default**; set `vector: { enabled: true }` and run the `index` command to opt in.

## Why the two placements differ

The core layer changes every few days; retrieval hits change on every user turn. Both are model-visible, but only one of them may sit in the system prompt.

A system-prompt section is the first message of every request, so any change to it moves the head of the prompt: prefix caching then misses from that point on, and every message after the system prompt — the entire conversation — is re-sent uncached. Runtime context does not have that cost. The harness materializes it as a user-role snapshot appended after the conversation, so replacing it invalidates only the tokens that follow it, which for a per-turn block is the turn itself.

Core text is read on the first assembly of each session and replayed from that session's snapshot, so `core.md` edits take effect in a new session without paying a disk read on every assembly. Snapshots remain until `session/disposed` and the cache therefore grows with the number and size of live session snapshots; disposal releases each one. Set `coreRefresh: 'always'` when edits must be visible immediately inside a live session. Without a session id (diagnostics, tests, non-agent assembly), the plugin rereads every time and keeps only a single last-read slot.

## Retrieval

BM25 over `stream.md` and the **names** of `ws/*.md`, tokenized for mixed Chinese/English text: Latin runs stay whole words (so identifiers such as `1234567890` remain searchable), CJK runs emit unigrams and bigrams (a trigram index cannot match a two-character Chinese query).

`core.md` is **not** in the recall corpus: it is injected in full every turn by `buildCore`, so recalling it as well would let the same text consume the prompt budget twice. The Python side (`nb_search.py`) follows the same rule by excluding `core` by default; this package matches it.

Workspace retrieval is deliberately **two-level**:

1. The level-1 corpus contains one document per workspace file, and that document is only `ws/<area>.md` plus the file's first line when it is a `# ...` heading. The body is never indexed. A hit renders as `- [ws/记忆系统.md]` with no text, and the hits block adds one hint: read the body with `py -3.14 <home>/../scripts/nb_search.py "查询" --file <区名>`. The path is derived from the configured `home` at mount time; set `detailHint` to replace the whole line.
2. Reading the body is an explicit second step, done outside the plugin with the Python CLI's repeatable `--file` flag. That command re-reads the file, splits it on `##`, scores the sections with the same BM25, and returns the text. There is no second content index to drift out of sync with the file. Its human output always states that it is level 2 and lists the files searched, even for zero hits, so "searched this file and found nothing" cannot look like "the flag did not take effect".

Why not just index the body: recall runs on **every** user message, and a workspace section is long. Any unrelated query could then pull a whole section into the prompt; in the DBA tree this actually happened with `ws/角色卡.md` (role-play notes recalled by an unrelated query). Level 1 answers "which note", level 2 answers "what it says", and only an explicit `--file` unlocks the second answer.

`exclude` remains supported (`exclude: ['角色卡.md']`), but it is an **extra guardrail**, not the gate. It matches by file name, so renaming a workspace file requires updating the list; the Python DBA's `nb_doctor` flags an entry that no longer exists on disk. The gate is that level 1 has no body to leak: even if an entry were missing from `exclude`, the corpus still contains only names and titles. Conversely, relying on `exclude` while indexing bodies means every file not on the list can still be recalled in full.

The semantic cache follows the same rule because it is built from the same corpus: workspace entries are name-only texts, so a semantic hit is rendered as `- [ws/<area>.md] (semantic)` and cannot surface a body. `core` is not in the corpus at all, so the semantic channel cannot score the injected text a second time; `stream` is unchanged.

Ranking is two-step:

1. relevance only — same query, same candidates;
2. if the candidate set exceeds the byte budget, rerank by relevance × recency.

Recency never introduces a candidate that relevance did not find.

Core is not indexed here at all (see above); stream entries split per non-empty line. Workspace files are not split at level 1 at all — one name-only document per file — and reported line numbers for them are `1`. Workspace additions, edits, removals, and renames invalidate the cached corpus using file names, sizes, and modification times.

For predictable stream retrieval latency, only the most recent **1,000 non-empty stream entries**, within **128 KiB of entry text**, are indexed. Individual entries larger than 128 KiB are skipped. Earlier entries remain on disk but are outside the candidate set; move lasting details into `ws/*.md` to keep them searchable. Workspace documents are not capped. A 5 MiB mixed Chinese/English stream is covered by a cold-load-plus-search benchmark test targeting 300 ms; actual timing depends on hardware. Reading and UTF-8 validation still scan the whole stream, so this is not a constant-time guarantee for arbitrarily large files.

If the first query finds no shared term, recall retries once with CJK unigrams plus Latin words. Existing shared-term hits are never relaxed. The result reports `relaxed: true` only when the retry supplies hits; there are at most two ranking attempts.

When level-1 recall returns no hits, the runtime context contributes one cold-path line instead of an empty block: it says so and names the Python CLI that searches the full history (`py -3.14 <home>/../scripts/nb_search.py "查询"`). A non-empty hit list never carries that line. `coldHint` overrides the sentence; `'off'` or an explicit empty value disables it.

## Semantic recall (optional)

Semantic recall is **off by default**. Level 1 is already narrow — core is injected in full, workspace documents are names only, and stream entries are short lines — while the synchronous worker waits up to 1500 ms and needs a GPU. On the current corpus it covered **0/143** non-core documents (core 67/74, stream 0/124, workspace 0/19), and core has since left the recall corpus entirely. The Python DBA CLI is the better path for semantic search over full text. To opt in on a machine with a warm `bge-m3`, set `vector: { enabled: true }`, then build the derived cache:

BM25 always works on a bare Node install. Install an Ollama embedding model separately, then build the derived cache:

```bash
ollama pull bge-m3
dsh-memory-dba index --home ./memory --url http://127.0.0.1:11434 --model bge-m3
```

Indexing uses four concurrent requests. Duplicate document texts share one entry (reported as skipped). Rebuild after editing memory; unchanged text still matches, while uncached or changed documents remain searchable by BM25. Indexing refuses with exit code 2 if the embedder is unavailable, without replacing the previous cache. Indexing requests have a separate 30-second timeout so model startup does not consume the recall budget.

The portable `<home>/.vec/embeddings.json` cache stores version, model, dimension, and SHA-1 document-text keys, never document paths. Each vector is quantized to signed int8 with its own `max(abs(vector)) / 127` scale and base64 bytes. `bge-m3` normally uses 1024 dimensions; the cache records the actual model dimension.

On each user message, a lazily reused, unreferenced worker embeds the query using `/api/embed` (falling back once to `/api/embeddings` on HTTP 404), then compares it with cached vectors by cosine similarity. Only document keys are sent, not corpus text. A fresh shared buffer returns at most eight matching corpus indices and scores. The main thread joins synchronously using `Atomics.wait`, with a **1500 ms total budget**, including worker startup and message posting. Prompt callbacks remain synchronous; no background result mutates a later turn's hits.

Keyword ranking is never rewritten by semantics. Hits above `minScore` that keywords missed are **appended** after the keyword hits, marked `(semantic)`, and cut to a 600-byte excerpt; the prompt budget keeps at most 70% for keyword hits so a long workspace section cannot crowd them out entirely. Fusion of the two rankings was tried and rejected: with no score floor, a semantic table of contents outranked an exact keyword match.

A cold `bge-m3` takes about two seconds to load, longer than the join budget, so when semantic recall is enabled the plugin fires one background warmup request on mount and asks Ollama to keep the model resident for `keepAlive`. After a failed or timed-out lookup the endpoint is skipped for 60 seconds, which keeps a down or cold embedder from costing the budget on every turn. When `vector.enabled` is false (the default), neither the warmup nor the worker path runs.

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

Useful while tuning `coreLimitKB` and inspecting why a note did or did not surface. The CLI is an operator tool; the plugin does not need it at runtime. `recall` is level 1 only — it prints `ws/<file>` for workspace hits; the body is read with the Python DBA CLI's `--file` second pass.

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
