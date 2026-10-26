/**
 * BM25 over the three memory layers, with CJK bigrams and optional recency.
 *
 * Retrieval is a two-step ladder that mirrors how the memory is written:
 *   1. rank by relevance only, so the same query yields the same candidates;
 *   2. when the candidate set overflows the prompt budget, rerank with a time
 *      weight so recent notes survive the cut.
 * Relevance never gets replaced by recency; the weight only reorders candidates
 * that already matched.
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { bytes, readLayer } from './store.mjs'
import { queryTerms, tokenize } from './tokenize.mjs'

const K1 = 1.5
const B = 0.75
export const STREAM_MAX_DOCS = 1000
export const STREAM_MAX_BYTES = 128 * 1024
const DATE_RE = /(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/

/**
 * @typedef {{ source: string, line: number, text: string, date: string|null }} MemoryDoc
 */

/**
 * Split one layer into retrievable units. Core and stream split per non-empty
 * line; a workspace file splits per `##` heading so a long note is one hit.
 *
 * @param {string} text Layer contents.
 * @param {string} source Layer label used in results.
 * @returns {MemoryDoc[]} Documents in source order.
 */
export function splitDocs(text, source) {
  const docs = []
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  let block = []
  let start = 1
  const flush = () => {
    const body = block.join('\n').trim()
    if (body) docs.push({ source, line: start, text: body, date: dateOf(body) })
    block = []
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const heading = source.startsWith('ws/') && /^##\s+/.test(line)
    if (!line.trim() || heading) {
      if (block.length) flush()
    }
    if (line.trim()) {
      if (!block.length) start = i + 1
      block.push(line)
      if (!source.startsWith('ws/')) flush()
    }
  }
  if (block.length) flush()
  return docs
}

/** First `YYYY-MM-DD[ HH:MM]` in the text, normalized to an ISO date string. */
export function dateOf(text) {
  const m = DATE_RE.exec(text || '')
  if (!m) return null
  const [, y, mo, d, h, mi] = m
  if (!h) return `${y}-${mo}-${d}`
  return `${y}-${mo}-${d}T${h}:${mi}`
}

/** Stream retrieval indexes a bounded recent window with original line numbers. */
function streamDocs(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const docs = []
  let used = 0
  for (let index = lines.length - 1; index >= 0 && docs.length < STREAM_MAX_DOCS; index -= 1) {
    const body = lines[index].trim()
    if (!body) continue
    const cost = bytes(body)
    if (cost > STREAM_MAX_BYTES) continue
    if (used + cost > STREAM_MAX_BYTES) break
    used += cost
    docs.push({ source: 'stream', line: index + 1, text: body, date: dateOf(body) })
  }
  return docs.reverse()
}

/** Unavailable or invalid layers are skipped unless strict diagnostics are requested. */
export function loadCorpus(home, { exclude = [], strict = false } = {}) {
  const docs = []
  for (const [file, label] of [['core.md', 'core'], ['stream.md', 'stream']]) {
    try {
      const text = readLayer(home, file)
      docs.push(...(label === 'stream' ? streamDocs(text) : splitDocs(text, label)))
    } catch (error) {
      if (strict && error?.name !== 'MissingLayer') throw error
    }
  }
  const wsDir = join(home, 'ws')
  let names = []
  try {
    names = readdirSync(wsDir).filter(name => name.endsWith('.md')).sort()
  } catch (error) {
    if (strict && error?.code !== 'ENOENT') throw error
  }
  const skip = new Set(exclude)
  for (const name of names) {
    if (skip.has(name)) continue
    try {
      docs.push(...splitDocs(readLayer(home, `ws/${name}`), `ws/${name}`))
    } catch (error) {
      if (strict && error?.name !== 'MissingLayer') throw error
    }
  }
  return docs
}

/**
 * @typedef {object} SearchOptions
 * @property {boolean} [timeDecay] Apply recency reranking.
 * @property {number} [halfLifeDays] Weight halves every N days.
 * @property {string} [now] Reference date, ISO; defaults to today.
 * @property {number} [budgetBytes] Rerank only when matching candidates exceed this budget.
 */

/**
 * Rank documents for a query.
 *
 * @param {MemoryDoc[]} docs Corpus.
 * @param {string} query User query.
 * @param {{ topK?: number, timeDecay?: boolean, halfLifeDays?: number, now?: string, budgetBytes?: number }} [options]
 * @returns {{ hits: Array<MemoryDoc & { score: number, base: number }>, applied: boolean, corpusDates: {dated: number, undated: number} }}
 */
export function search(docs, query, options = {}) {
  const topK = Math.max(1, options.topK ?? 5)
  const terms = queryTerms(query)
  const empty = { hits: [], applied: false, corpusDates: { dated: 0, undated: 0 } }
  if (!terms.size || !docs.length) return empty

  const postings = new Map()
  const lengths = new Array(docs.length)
  for (let i = 0; i < docs.length; i += 1) {
    const tokens = tokenize(docs[i].text)
    lengths[i] = tokens.length || 1
    const tf = new Map()
    for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1)
    for (const [term, count] of tf) {
      let list = postings.get(term)
      if (!list) postings.set(term, (list = new Map()))
      list.set(i, count)
    }
  }

  const total = docs.length
  const avgLen = lengths.reduce((a, b) => a + b, 0) / total
  const scores = new Map()
  for (const [term, boost] of terms) {
    const list = postings.get(term)
    if (!list) continue
    const idf = Math.log(1 + (total - list.size + 0.5) / (list.size + 0.5))
    for (const [i, tf] of list) {
      const denom = tf + K1 * (1 - B + (B * lengths[i]) / avgLen)
      const gain = boost * idf * ((tf * (K1 + 1)) / denom)
      scores.set(i, (scores.get(i) || 0) + gain)
    }
  }
  if (!scores.size) return empty

  const base = [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([i, score]) => ({ ...docs[i], score, base: score }))

  const dated = base.filter(hit => hit.date)
  const corpusDates = { dated: dated.length, undated: base.length - dated.length }

  const withinBudget = Number.isFinite(options.budgetBytes)
    && base.reduce((total, hit) => total + bytes(hit.text) + 48, 0) <= options.budgetBytes
  if (!options.timeDecay || !dated.length || withinBudget) {
    return { hits: base.slice(0, topK), applied: false, corpusDates }
  }

  const reference = options.now ? Date.parse(options.now) : Date.now()
  const halfLife = options.halfLifeDays && options.halfLifeDays > 0 ? options.halfLifeDays : 30
  const weights = new Map()
  for (const hit of dated) {
    const ageDays = Math.max(0, (reference - Date.parse(hit.date)) / 86_400_000) || 0
    weights.set(hit, Math.max(0.5, 0.5 ** (ageDays / halfLife)))
  }
  const sortedWeights = [...weights.values()].sort((a, b) => a - b)
  const neutral = sortedWeights[Math.floor(sortedWeights.length / 2)]
  const reranked = base
    .map(hit => ({ ...hit, weight: weights.get(hit) ?? neutral }))
    .sort((a, b) => b.base * b.weight - a.base * a.weight)
    .map(({ weight, ...hit }) => ({ ...hit, score: hit.base * weight }))

  return { hits: reranked.slice(0, topK), applied: true, corpusDates, timeWeightNeutral: neutral }
}

/**
 * Pick hits that fit a byte budget, keeping rank order. A single oversized hit
 * is kept and reported as truncated by the caller, never silently dropped.
 *
 * @param {Array<MemoryDoc & { score: number }>} hits Ranked hits.
 * @param {number} budgetBytes Prompt budget for the retrieval section.
 */
export function fitHits(hits, budgetBytes) {
  const kept = []
  let used = 0
  for (const hit of hits) {
    const cost = bytes(hit.text) + 48
    if (used + cost > budgetBytes && kept.length) break
    kept.push(hit)
    used += cost
  }
  return kept
}

/** Memory-directory stats for the CLI and for doctor output. */
export function corpusStats(home) {
  const stats = { layers: {}, docs: 0, bytes: 0 }
  for (const name of ['core.md', 'stream.md']) {
    try {
      const size = statSync(join(home, name)).size
      stats.layers[name] = size
      stats.bytes += size
    } catch {
      stats.layers[name] = 0
    }
  }
  try {
    for (const name of readdirSync(join(home, 'ws')).filter(f => f.endsWith('.md'))) {
      const size = statSync(join(home, 'ws', name)).size
      stats.layers[`ws/${name}`] = size
      stats.bytes += size
    }
  } catch { /* no workspace layer yet */ }
  stats.docs = loadCorpus(home).length
  return stats
}
