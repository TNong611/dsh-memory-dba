/**
 * dsh-memory-dba — a file-based, git-portable memory plugin for DeepSeek Harness.
 *
 * Three layers, mirroring how the notes are actually maintained:
 *   core.md      injected in full every turn, budget-capped
 *   stream.md    a timeline, retrieved only
 *   ws/*.md      detail notes, retrieved only
 *
 * The plugin owns injection and turn recording; retrieval is BM25 over all three
 * layers, so the package has no runtime outside Node itself.
 *
 * Failure policy: memory is an enhancement. A broken layer, a missing directory,
 * or a corrupt index degrades to an empty section and never fails the turn.
 */

import { buildCore, buildHits } from './assemble.mjs'
import { fitHits, loadCorpus, search } from './search.mjs'
import { bytes, ensureLayout, fingerprint, resolveHome } from './store.mjs'
import { appendTurn } from './stream.mjs'
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
  coreOrder: -50,
  hitsOrder: 200,
  vector: { enabled: true, url: 'http://127.0.0.1:11434', model: 'bge-m3', timeoutMs: 1500, minScore: 0.45, keepAlive: '30m' },
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
    vector: {
      enabled: vector.enabled !== false,
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
 */
export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  const home = resolveHome(cfg.home)

  try {
    ensureLayout(home)
  } catch (error) {
    // An unwritable home disables persistence but must not break startup.
    console.error(`[memory-dba] cannot initialize ${home}: ${error.message}`)
  }

  // A cold Ollama takes longer than the synchronous recall budget, so warm it in the
  // background; the first turn would otherwise lose semantic recall.
  if (cfg.vector.enabled) {
    embed('warmup', { url: cfg.vector.url, model: cfg.vector.model, timeoutMs: 8000, keepAlive: cfg.vector.keepAlive })
      .catch(() => {})
  }

  let corpus = null
  let corpusKey = ''
  // The assembly context carries only a scope key, not a session id, so recall text
  // is single-slot: the most recent user turn wins. Concurrent sessions (subagents)
  // therefore render the last query, not their own.
  let latestHits = ''
  const pending = new Map()

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
      ? semanticRecall(home, query, corpus.map(doc => docKey(doc.text)), { ...cfg.vector, topK: cfg.topK })
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
    return buildHits(result.hits, { budgetKB: cfg.hitBudgetKB })
  }

  ctx.on('session/disposed', session => {
    pending.delete(session?.id)
  })

  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session?.id
      if (!sessionId) return
      if (event?.type === 'user/message') {
        if (event.data?.source?.kind !== 'user') return
        pending.delete(sessionId)
        const user = textOf(event.data?.content)
        if (!user) return
        pending.set(sessionId, { user, assistant: '', at: new Date() })
        latestHits = renderHits(user).text
        return
      }
      if (event?.type === 'assistant/message') {
        const turn = pending.get(sessionId)
        if (!turn) return
        const text = textOf(event.data?.message?.content)
        if (!text) return
        turn.assistant = turn.assistant ? `${turn.assistant}\n${text}` : text
        return
      }
      if (event?.type === 'turn/end') {
        const turn = pending.get(sessionId)
        if (!turn) return
        pending.delete(sessionId)
        if (!cfg.writeStream) return
        const outcome = appendTurn(home, { ...turn, tag: cfg.tag })
        if (outcome.written) corpus = null
      }
    } catch (error) {
      console.error(`[memory-dba] session event failed: ${error.message}`)
    }
  })

  ctx.systemPrompt.section({
    name: 'memory-dba:core',
    order: cfg.coreOrder,
    text: () => {
      try {
        return buildCore(home, { coreLimitKB: cfg.coreLimitKB }).text
      } catch {
        return ''
      }
    },
  })

  ctx.systemPrompt.section({
    name: 'memory-dba:hits',
    order: cfg.hitsOrder,
    text: () => latestHits,
  })
}

/** Exposed for tests: the retrieval path without a harness context. */
export { buildCore, buildHits, fitHits, loadCorpus, search }
