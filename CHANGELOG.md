# Changelog

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
  but did not meet acceptance (dev all-slot exact 0/1779, no-state loss better than
  true-state, Not qualified, no final test). It is not described as untrained.

## 0.1.1 — 2026-10-26

- Package metadata only: added `repository`, `homepage`, and `bugs` so the npm
  page links back to the GitHub source. No source file, API, or behavior changed.

## 0.1.0 — 2026-10-26

- First functional release: three-layer store, two-section prompt injection, BM25
  with CJK bigrams, optional Ollama/bge-m3 semantic recall, DSH session-event
  integration, CLI, and 40 tests.

## 0.0.0-stage — 2026-10-26

- Temporary placeholder build; deprecated in favour of later versions.
