# Changelog

## 0.3.0 — 2026-11-04

- Persist complete sanitized text events before stream publication; retain drafts, source roles and candidate observations. Recover completed unpublished turns without duplicate event references.
- Keep bounded head-and-tail stream excerpts with explicit event references.
- Add shared topic cards and evidence-backed fact revisions, retraction and conflict labels, with explicit CLI authoring and history inspection.
- Validate Python keyword index freshness against content manifests; rebuild atomically on append, edit, rename, deletion or schema changes.
- Keep workspace bodies behind explicit file selection and versioned facts out of independent Python vector caches. CLI semantic recall requires opt-in.
- Preserve the previous session snapshot, isolation and retrieval-budget fixes.


## 0.2.2 — 2026-11-03

Session-scoped prompt state, a cold-path hint, and a smaller default surface.

- **Core is snapshotted per session.** The `memory-dba:core` provider now reads
  once on the first assembly of a session (`context.agent.id`) and replays
  `{text, bytes, clipped}` for the rest of that session, keeping the cacheable
  head stable. New session = new id = latest file. `coreRefresh: 'always'` opts
  back into a read on every assembly. Without an agent id the provider rereads
  every time and keeps only a last-read slot. Session snapshots remain until
  `session/disposed`; memory usage therefore scales with the number and size of
  live sessions, and disposal releases each snapshot.
- **Hits are isolated per session.** `latestHits` was one process-wide slot, so
  two live sessions overwrote each other. Hits now live in a
  `Map<sessionId, text>` written by `user/message` and read by
  `context.agent.id`; contexts without an id keep the old single-slot fallback.
  Disposal clears the session entry.
- **Empty recall gets a cold-path hint.** `buildHits()` returns one line naming
  the Python index (`py -3.14 <home>/../scripts/nb_search.py "查询"`) instead of
  `''` when there are no hits; a non-empty hit list never carries it. The new
  `coldHint` config replaces the sentence; `'off'` or an explicit empty value
  disables it.
- **Semantic recall is off by default.** `vector.enabled` now defaults to
  `false`. Level 1 is already narrow (core injected in full, workspace names
  only, stream short lines), while the synchronous worker costs up to 1500 ms
  and a GPU for a measured 0/143 non-core coverage (core 67/74, stream 0/124,
  workspace 0/19). The Python CLI remains the semantic path over full text.
  `vector: { enabled: true }` explicitly restores the old behavior; when it is
  false neither the warmup nor `semanticRecall` runs.
- **Tests.** Default config never calls the vector runtime; a stub proves one
  core read per session, retention past 32 live sessions, disposal refresh,
  `always` rereading, and the no-id fallback; two sessions keep separate hits
  and disposal clears them;
  empty recall shows the hint while a disabled/overridden hint behaves; the
  semantic-only injection test now opts in explicitly.

## 0.2.1 — 2026-11-03

Retrieval-corpus change: `core.md` is injection-only, matching the Python side.

- **`core` leaves the recall corpus.** `loadCorpus()` now indexes `stream.md` and
  the workspace names only. `buildCore()` is unchanged and still injects the whole
  core layer as a system-prompt section every turn. Core was previously in both
  places, so the same text could consume the prompt budget twice; the Python
  `nb_search.py` already excludes `core` by default for exactly this reason.
- **Semantic channel.** Its keys come from the same corpus, so core is no longer
  scored there either; a key set without core entries is valid.
- **Tests.** The corpus contains no `source === 'core'` document, `buildCore()`
  still returns the core text, a core-only term produces an empty recall block,
  and the semantic key set from a core-less corpus is accepted.

## 0.2.0 — 2026-11-03

Runtime change: workspace layers are retrieved in two levels, and level 1 knows
only file names.

- **Level-1 corpus.** One document per `ws/*.md` file. Its text is exactly
  `ws/<area>.md` plus the first line when that line is a `# ...` heading; the
  body is never indexed. `date` is `null` for these documents because a section
  date cannot exist without the section body.
- **Rendering.** Workspace hits render as `- [ws/<area>.md]` with no body (the
  `(semantic)` marker is preserved). The hits block adds one hint per block:
  read the body with `py -3.14 <home>/../scripts/nb_search.py "查询" --file <区名>`.
  The script path is derived from the configured `home` once at mount; the new
  `detailHint` config replaces the whole hint line (non-Windows installs, another
  Python launcher). The hint is placed before the hit bullets so a tight budget
  cannot clip it away.
- **Python output.** `nb_search.py` level 1 uses one numbering sequence, so a
  name-only workspace row is `1. [ws/<area>.md]` and the following stream hits
  continue `2.`, `3.`; level 2 always prints the level and the files it searched,
  including when nothing matched — a zero-hit second pass can never look like a
  plain level-1 miss.
- **Semantic channel.** The embedding cache is built from the same corpus, so
  workspace entries are name-only there too and a semantic hit renders as the
  file name. The vector path can no longer bypass level 1.
- **Why.** Recall runs on every user message, while a workspace section is long.
  With body indexing, any unrelated query could pull a whole section into the
  prompt; in the DBA tree this happened with `ws/角色卡.md`. Level 1 answers
  "which note is relevant", level 2 answers "what it says", and only an explicit
  `--file` unlocks the second answer.
- **Python side.** `nb_index.py` writes name-only workspace documents and rejects
  old indexes by version; `nb_search.py --file` re-reads the file, splits on
  `##`, reuses BM25 and errors non-zero when a file is missing; `port/dba.py`
  forwards `files=` without changing the default level-1 behavior.
- **`exclude` stays.** It is an extra guardrail, not the gate: the gate is that
  level 1 contains no body at all. Relying on an exclusion list while indexing
  bodies means every unlisted file can still be recalled in full.
- **Tests.** Area-name retrieval, body text absent from rendered hits, the
  `--file` hint, body-only queries not surfacing a workspace file, name-only
  semantic excerpts, and first-line-title extraction.

## 0.1.6 — 2026-11-03

Runtime change: per-turn retrieval hits moved out of the system prompt.

- The `hits` block is now registered with `systemPrompt.context()` (default order
  `300`, above the harness's own contexts at 100–210) instead of
  `systemPrompt.section()`. The harness materializes runtime context as a user-role
  snapshot appended after the conversation.
- Why it matters: a section is the first message of a request, so a hit list that
  changed inside it moved the prompt head and invalidated prefix caching for every
  message behind it — the whole conversation, once per turn. Measured on a local
  corpus of 13,734 requests: step 2 of a turn ran at a **51.4%** hit rate (47.3M
  uncached tokens, 23.7% of all misses) while step 3 and later ran at 92.9–96%.
  A single 550k-token session showed a constant 4,992-token hit, exactly the common
  prompt head, on every affected request.
- `core` stays a system-prompt section (order `-50`) — it changes every few days,
  not every turn.
- Config: `hitsOrder` default `200` → `300`, now a runtime-context order.
- Tests: a regression test pins `hits` to runtime context so the block cannot drift
  back into the system prompt.

## 0.1.5 — 2026-10-26

Documentation-only revision. No runtime source file, API, or behavior changed.

- Separated the two state interfaces that the earlier scope text merged into one:
  **(A) memory-token prefix** (frozen RWKV state → *k* continuous tokens prepended
  to a frozen LLM's instruction embeddings, trained on downstream task error) and
  **(B) state-to-text slot decoding** (state → four readable slots → text).
- Recorded route (A)'s actual standing: 0.5477 vs 0.6774 direct-MLP baseline on 50
  sealed test episodes, episode-specific per the correct/wrong/zero/random ablation,
  but token-count ranking unsettled, 64-token seeds incomplete, and behind the MLP
  baseline on a 192k-sample budget.
- Bounded every `0/1779` figure to route (B), and named the runtime's actual third
  path: text summaries plus retrieval.

## 0.1.4 — 2026-10-26

Documentation-only revision. No runtime source file, API, or behavior changed.

- Corrected an inverted research claim. `0.1.2`/`0.1.3` said the v4 state decoder's
  no-state loss was better than its true-state loss. The recorded run says the
  opposite: on dev (1,779 cases) true-state token loss was **1.185**, against
  **1.575** with no state and **1.260** with a mismatched state. The decoder fails
  on joint multi-label extraction (all-slot exact 0/1779, content-slot accuracy
  1.6%), not because the frozen state carries no signal; per-label linear probes
  on the same pooled features reach AUC 0.98.
- `README.zh-CN.md` now carries the same corrected numbers.

## 0.1.3 — 2026-10-26

Documentation-only revision. No runtime source file, API, or behavior changed.

- Corrected the release history: `0.1.0` was the first functional release; `0.1.1`
  only added `repository`/`homepage`/`bugs` metadata.
- README release section renamed to "Release notes" so it no longer hardcodes the
  version it documents.

## 0.1.2 — 2026-10-26

Documentation-only revision. No runtime source file, API, or behavior changed.

- Added a Chinese scope summary in `README.zh-CN.md`.
- README now separates three delivery classes explicitly: implemented in this npm
  package, present in the original Python DBA but not migrated here, and still
  unaccepted research in the overall DBA project.
- Added the capability comparison tables and a legacy note: the older five-layer
  consolidation/retire/dedupe path is legacy in the current DBA, not a current
  capability missing from this package.
- Added a "Limits and operating notes" section covering: process-wide single-slot
  retrieval (`latestHits`) with no concurrent-session/subagent isolation; the
  recent-1,000-entries / 128 KiB stream recall window (the byte cap is enforced in
  source but was not independently end-to-end tested); 300/600-character
  truncation of stream text instead of model summarization; manual `index` for the
  semantic cache; core overflow clipping instead of compression; log-only write
  failures without retry; and the default memory directory differing from the old
  Python DBA, which requires an explicit `home` to reuse an existing library.
- Corrected the research status: state-decoder training on frozen RWKV features was performed (v4, 5,000 steps)
  but did not meet acceptance (dev all-slot exact 0/1779, Not qualified, no final
  test). It is not described as untrained. This entry originally also claimed the
  no-state loss beat the true-state loss; that was wrong and is superseded by 0.1.4.

## 0.1.1 — 2026-10-26

- Package metadata only: added `repository`, `homepage`, and `bugs` so the npm
  page links back to the GitHub source. No source file, API, or behavior changed.

## 0.1.0 — 2026-10-26

- First functional release: three-layer store, two-section prompt injection, BM25
  with CJK bigrams, optional Ollama/bge-m3 semantic recall, DSH session-event
  integration, CLI, and 40 tests.

## 0.0.0-stage — 2026-10-26

- Temporary placeholder build; deprecated in favour of later versions.
