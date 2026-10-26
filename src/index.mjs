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
import { ensureLayout, fingerprint, resolveHome } from './store.mjs'
import { appendTurn } from './stream.mjs'

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
  }
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

  const recall = query => {
    if (!query) return { hits: [], applied: false, clipped: false }
    const result = search(docs(), query, {
      topK: cfg.topK,
      timeDecay: cfg.timeDecay,
      halfLifeDays: cfg.halfLifeDays,
      budgetBytes: cfg.hitBudgetKB * 1024,
    })
    const hits = fitHits(result.hits, Math.max(1, cfg.hitBudgetKB) * 1024)
    return { ...result, hits }
  }

  const renderHits = query => {
    const result = recall(query)
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
