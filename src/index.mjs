/**
 * dsh-memory-dba — a file-based, git-portable memory plugin for DeepSeek Harness.
 *
 * Three layers, mirroring how the notes are actually maintained:
 *   core.md      injected in full every turn, budget-capped
 *   stream.md    a timeline, retrieved only
 *   ws/*.md      detail notes, retrieved only
 *
 * Placement decides whether the prompt cache survives. `core.md` goes in as a
 * system-prompt section, which is the stable head every request shares. Retrieval
 * hits change on every user turn, so they are contributed as runtime context
 * instead: the harness materializes that as a trailing user snapshot, leaving every
 * earlier message byte-identical. The same text returned from a system-prompt
 * section would land near the head and invalidate the whole conversation after it.
 *
 * The plugin owns injection and turn recording; retrieval is BM25 over the
 * stream and workspace names, so the package has no runtime outside Node itself.
 *
 * Failure policy: memory is an enhancement. A broken layer, a missing directory,
 * or a corrupt index degrades to an empty section and never fails the turn.
 */

import { join } from 'node:path'
import { buildCore, buildHits } from './assemble.mjs'
import { fitHits, loadCorpus, search } from './search.mjs'
import { bytes, ensureLayout, fingerprint, resolveHome } from './store.mjs'
import { publishEvent } from './stream.mjs'
import { completeEvent, createPendingEvent, interruptEvent, listOutbox, readEvent, updateEventAssistant } from './events.mjs'
import { queryTerms, tokenize } from './tokenize.mjs'
import { embed } from './embed.mjs'
import { docKey, semanticRecall } from './vector.mjs'

export const name = 'memory-dba'

/** The plugin reads and writes prompt sections through this service. */
export const inject = ['systemPrompt']

/** Config defaults; every field is overridable from cordis.yml. */
export const defaults = {
  home: '',
  coreLimitKB: 15,
  hitBudgetKB: 6,
  topK: 5,
  timeDecay: true,
  halfLifeDays: 30,
  writeStream: true,
  tag: '',
  exclude: [],
  /**
   * Full text of the level-1 workspace hint. Empty means derive the command from
   * `home` (`<home>/../scripts/nb_search.py`); set it for non-Windows installs or
   * a different Python launcher.
   */
  detailHint: '',
  /**
   * Text contributed when level-1 recall has no hits. Empty derives a sentence
   * naming the Python index; `'off'` (or an explicit `false`) disables it.
   */
  coldHint: '',
  /**
   * `session` snapshots core.md on first assembly per session (the stable head
   * must not change mid-session); `always` re-reads every assembly for edits
   * that must apply immediately.
   */
  coreRefresh: 'session',
  coreOrder: -50,
  /**
   * Order of the retrieval-hits runtime context. Above the harness's own contexts
   * (repository 100–200, web surface 210) so memory stays the last thing the model
   * reads in the snapshot.
   */
  hitsOrder: 300,
  /**
   * Semantic recall is off by default. Level 1 is already narrow: core is
   * injected in full, workspace documents are names only, and stream entries
   * are short lines. The synchronous 1500 ms worker/GPU cost bought a measured
   * 0/143 non-core coverage (core 67/74, stream 0/124, workspace 0/19), while
   * core no longer belongs in the recall corpus. Use the Python CLI for semantic
   * search over full text; enable this only on a machine with a warm bge-m3.
   */
  vector: { enabled: false, url: 'http://127.0.0.1:11434', model: 'bge-m3', timeoutMs: 1500, minScore: 0.45, keepAlive: '30m' },
}

/** Text of one message's content blocks, ignoring tool calls and images. */
function textOf(blocks) {
  if (typeof blocks === 'string') return blocks.trim()
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** Coerce a number, falling back when the config value is missing or invalid. */
function num(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Merge user config over defaults, rejecting unusable values instead of propagating NaN. */
export function normalizeConfig(config = {}) {
  const cfg = { ...defaults, ...config }
  const vector = cfg.vector && typeof cfg.vector === 'object' ? cfg.vector : {}
  const timeoutMs = vector.timeoutMs == null ? NaN : Number(vector.timeoutMs)
  const minScore = vector.minScore == null ? NaN : Number(vector.minScore)
  const keepAlive = typeof vector.keepAlive === 'string' && vector.keepAlive.trim() ? vector.keepAlive.trim() : defaults.vector.keepAlive
  let url = defaults.vector.url
  try {
    const parsed = new URL(vector.url)
    if (['http:', 'https:'].includes(parsed.protocol)) url = parsed.href.replace(/\/$/, '')
  } catch {}
  return {
    ...cfg,
    home: typeof cfg.home === 'string' ? cfg.home : '',
    coreLimitKB: num(cfg.coreLimitKB, defaults.coreLimitKB, { min: 1, max: 512 }),
    hitBudgetKB: num(cfg.hitBudgetKB, defaults.hitBudgetKB, { min: 1, max: 128 }),
    topK: num(cfg.topK, defaults.topK, { min: 1, max: 50 }),
    halfLifeDays: num(cfg.halfLifeDays, defaults.halfLifeDays, { min: 1, max: 3650 }),
    coreOrder: num(cfg.coreOrder, defaults.coreOrder),
    hitsOrder: num(cfg.hitsOrder, defaults.hitsOrder),
    timeDecay: cfg.timeDecay !== false,
    writeStream: cfg.writeStream !== false,
    tag: typeof cfg.tag === 'string' ? cfg.tag : '',
    exclude: Array.isArray(cfg.exclude) ? cfg.exclude.filter(name => typeof name === 'string') : [],
    detailHint: typeof cfg.detailHint === 'string' ? cfg.detailHint : '',
    coldHint: typeof cfg.coldHint === 'string' ? cfg.coldHint : '',
    coreRefresh: cfg.coreRefresh === 'always' ? 'always' : 'session',
    vector: {
      // Explicit opt-in only: the default is false so a missing/partial vector
      // config cannot silently re-enable the synchronous worker path.
      enabled: vector.enabled === true,
      url,
      model: typeof vector.model === 'string' && vector.model.trim() ? vector.model : defaults.vector.model,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1 ? Math.floor(timeoutMs) : defaults.vector.timeoutMs,
      minScore: Number.isFinite(minScore) && minScore >= 0 && minScore <= 1 ? minScore : defaults.vector.minScore,
      keepAlive,
    },
  }
}

export function recall(docs, query, options = {}) {
  const first = search(docs, query, options)
  const terms = queryTerms(query)
  const shared = docs.some(doc => tokenize(doc.text).some(term => terms.has(term)))
  if (!shared && (!first.hits.length || first.hits[0].score < 6)) {
    const reduced = tokenize(query)
      .filter(term => !/^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]{2}$/.test(term))
      .join(' ')
      || [...query].filter(char => /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(char)).join(' ')
    const second = reduced ? search(docs, reduced, options) : { hits: [] }
    if (second.hits.length) return { ...second, relaxed: true }
  }
  return { ...first, relaxed: false }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Partial<typeof defaults>} config
 * @param {{
 *   buildCore?: typeof buildCore,
 *   vector?: { embed?: typeof embed, semanticRecall?: typeof semanticRecall },
 * }} [runtime] Test seam; production callers omit it. Lets tests prove that the
 *   default config never calls the vector runtime and that core reads are
 *   per-session.
 */
export function apply(ctx, config = {}, runtime = {}) {
  const cfg = normalizeConfig(config)
  const home = resolveHome(cfg.home)
  const coreBuilder = runtime.buildCore || buildCore
  const vectorRuntime = { embed, semanticRecall, ...(runtime.vector || {}) }
  // Derived once per mount: the hint names the Python DBA script that performs
  // the level-2 read. `home` is the memory directory, so the script lives in its
  // sibling `scripts/`; an explicit `detailHint` replaces the whole line for
  // installs that use another launcher or a different tree layout.
  const scriptPath = join(home, '..', 'scripts', 'nb_search.py')
  const detailHint = cfg.detailHint || `工作区册只给文件名；详情用：py -3.14 ${scriptPath} "查询" --file <区名>`
  // Cold hint follows detailHint's convention (empty derives, a string wins),
  // but an explicitly supplied empty value turns it off. `Object.hasOwn` is what
  // distinguishes "not configured" from "configured empty" — normalizeConfig
  // cannot, because its default is also ''.
  const defaultColdHint = `本地召回本轮无命中；全量历史（含更早的 stream 记录）用 py -3.14 ${scriptPath} "查询" 查（工作区册正文用 --file <区名>）。`
  const coldHint = (() => {
    if (!Object.hasOwn(config || {}, 'coldHint')) return defaultColdHint
    const raw = config.coldHint
    if (raw === '' || raw === false || raw === null) return ''
    if (typeof raw === 'string' && raw.trim().toLowerCase() === 'off') return ''
    return typeof raw === 'string' && raw.trim() ? raw : defaultColdHint
  })()

  try {
    ensureLayout(home)
  } catch (error) {
    // An unwritable home disables persistence but must not break startup.
    console.error(`[memory-dba] cannot initialize ${home}: ${error.message}`)
  }

  // A cold Ollama takes longer than the synchronous recall budget, so warm it in the
  // background; the first turn would otherwise lose semantic recall. With the
  // default `vector.enabled: false` this branch never runs, so no fetch/worker.
  if (cfg.vector.enabled) {
    vectorRuntime.embed('warmup', { url: cfg.vector.url, model: cfg.vector.model, timeoutMs: 8000, keepAlive: cfg.vector.keepAlive })
      .catch(() => {})
  }

  let corpus = null
  let corpusKey = ''
  /** One slot for contexts without a session id (diagnostics/tests/subagents). */
  let latestHits = ''
  /** Per-session recall text; a shared slot would leak one session's hits into another. */
  const hitsBySession = new Map()
  /**
   * Core snapshots keyed by session id. `{text, bytes, clipped}` is already the
   * clipped section, so the model sees the same head for the whole session.
   * Snapshots live for the session lifetime and are released on session/disposed;
   * retaining every active session is required to keep its prompt head stable.
   */
  const coreSnapshots = new Map()
  /** Last read for the no-session-id fallback; never used to skip a read. */
  let fallbackCore = null
  const pending = new Map()

  // Repair complete archives whose stream publication was interrupted. Scanning
  // event files here is recovery only; recall indexing remains stream-only.
  if (cfg.writeStream) {
    try { for (const id of listOutbox(home)) { try { const event = readEvent(home, id); if (event?.status === 'complete') publishEvent(home, id) } catch (error) { console.error(`[memory-dba] event recovery skipped ${id}: ${error.message}`) } } }
    catch (error) { console.error(`[memory-dba] event recovery failed: ${error.message}`) }
  }

  const docs = () => {
    const key = fingerprint(home)
    if (corpus && key === corpusKey) return corpus
    corpus = loadCorpus(home, { exclude: cfg.exclude })
    corpusKey = key
    return corpus
  }

  const recallQuery = query => {
    if (!query) return { hits: [], applied: false, clipped: false }
    const corpus = docs()
    const semantic = cfg.vector.enabled
      ? vectorRuntime.semanticRecall(home, query, corpus.map(doc => docKey(doc.text)), { ...cfg.vector, topK: cfg.topK })
      : null
    const result = recall(corpus, query, {
      topK: cfg.topK,
      timeDecay: cfg.timeDecay,
      halfLifeDays: cfg.halfLifeDays,
      budgetBytes: cfg.hitBudgetKB * 1024,
      semantic,
      semanticMinScore: cfg.vector.minScore,
    })
    const budget = Math.max(1, cfg.hitBudgetKB) * 1024
    const keyword = result.hits.filter(hit => !hit.semantic)
    const semanticHits = result.hits.filter(hit => hit.semantic)
    // Keyword hits own the prompt; semantic excerpts get a reserved tail so a long
    // workspace section cannot crowd them out entirely.
    const keptKeyword = fitHits(keyword, semanticHits.length ? Math.floor(budget * 0.7) : budget)
    const used = keptKeyword.reduce((total, hit) => total + bytes(hit.text) + 48, 0)
    const hits = used < budget ? keptKeyword.concat(fitHits(semanticHits, budget - used)) : keptKeyword
    return { ...result, hits }
  }

  const renderHits = query => {
    const result = recallQuery(query)
    return buildHits(result.hits, { budgetKB: cfg.hitBudgetKB, detailHint, coldHint })
  }

  /** Read + clip core now, and record the bytes/clipped flags with the snapshot. */
  const readCore = () => {
    const snapshot = coreBuilder(home, { coreLimitKB: cfg.coreLimitKB })
    const text = snapshot?.text ?? ''
    return { text, bytes: bytes(text), clipped: Boolean(snapshot?.clipped) }
  }

  /**
   * Core section text, resolved per assembly.
   *
   * The system prompt must stay byte-identical for a session or prefix caching
   * loses the whole head; therefore the default `coreRefresh: 'session'` reads
   * core.md once per session id and replays that snapshot. A new session gets a
   * new id and reads the latest file. `coreRefresh: 'always'` opts out for
   * edits that must be visible immediately.
   *
   * Without `context.agent.id` (diagnostics, tests, non-agent assembly) there is
   * no safe cache key: a single global snapshot would leak one session's core
   * into another. That path reads on every assembly and keeps only the last
   * read in `fallbackCore` for the section contract.
   */
  const coreText = context => {
    try {
      if (cfg.coreRefresh === 'always') {
        fallbackCore = readCore()
        return fallbackCore.text
      }
      const id = context?.agent?.id
      if (!id) {
        fallbackCore = readCore()
        return fallbackCore.text
      }
      const cached = coreSnapshots.get(id)
      if (cached) return cached.text
      const snapshot = readCore()
      coreSnapshots.set(id, snapshot)
      return snapshot.text
    } catch {
      // A broken core must not fail assembly; the next assembly retries.
      return ''
    }
  }

  ctx.on('session/disposed', session => {
    const sessionId = session?.id
    if (!sessionId) return
    pending.delete(sessionId)
    // Session-scoped prompt text must not outlive the session: otherwise a
    // later id reuse (or a long process's map) serves stale hits/core.
    hitsBySession.delete(sessionId)
    coreSnapshots.delete(sessionId)
  })

  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session?.id
      if (!sessionId) return
      if (event?.type === 'user/message') {
        if (event.data?.source?.kind !== 'user') return
        const previous = pending.get(sessionId)
        if (previous?.eventId) {
          try { interruptEvent(home, previous.eventId) }
          catch (error) { console.error(`[memory-dba] cannot interrupt prior archive: ${error.message}`) }
        }
        pending.delete(sessionId)
        const user = textOf(event.data?.content)
        if (!user) return
        const at = new Date()
        let archive = null
        if (cfg.writeStream) {
          try { archive = createPendingEvent(home, { session_id: sessionId, user, at, tag: cfg.tag }) }
          catch (error) { console.error(`[memory-dba] cannot archive pending event: ${error.message}`) }
        }
        pending.set(sessionId, { user, assistant: '', at, eventId: archive?.id })
        let text = ''
        try { text = renderHits(user).text }
        catch (error) { console.error(`[memory-dba] recall failed: ${error.message}`) }
        hitsBySession.set(sessionId, text)
        // Keep the no-session-id fallback in sync with the latest turn.
        latestHits = text
        return
      }
      if (event?.type === 'assistant/message') {
        const turn = pending.get(sessionId)
        if (!turn) return
        const text = textOf(event.data?.message?.content)
        if (!text) return
        turn.assistant = turn.assistant ? `${turn.assistant}\n${text}` : text
        if (turn.eventId) {
          try { updateEventAssistant(home, turn.eventId, text) }
          catch (error) { console.error(`[memory-dba] cannot update event archive: ${error.message}`) }
        }
        return
      }
      if (event?.type === 'turn/end') {
        const turn = pending.get(sessionId)
        if (!turn) return
        pending.delete(sessionId)
        if (!cfg.writeStream) return
        if (!turn.eventId) return
        if (!turn.assistant.trim()) {
          interruptEvent(home, turn.eventId)
          return
        }
        completeEvent(home, turn.eventId, turn)
        const outcome = publishEvent(home, turn.eventId, { tag: cfg.tag })
        if (outcome.written) corpus = null
      }
    } catch (error) {
      console.error(`[memory-dba] session event failed: ${error.message}`)
    }
  })

  ctx.systemPrompt.section({
    name: 'memory-dba:core',
    order: cfg.coreOrder,
    text: coreText,
  })

  // Retrieval hits change per turn, so they must not touch the cacheable head:
  // runtime context is materialized after the conversation history, where a change
  // costs only the tokens that follow it. Resolve by the assembly's agent id;
  // contexts without one fall back to the latest single slot.
  ctx.systemPrompt.context({
    name: 'memory-dba:hits',
    order: cfg.hitsOrder,
    text: context => {
      const id = context?.agent?.id
      if (id) return hitsBySession.get(id) ?? ''
      return latestHits
    },
  })
}

/** Exposed for tests: the retrieval path without a harness context. */
export { buildCore, buildHits, fitHits, loadCorpus, search, readEvent }
