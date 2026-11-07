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

import { lstatSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { bytes, readLayer } from './store.mjs'
import { queryTerms, tokenize } from './tokenize.mjs'
import { docKey } from './vector.mjs'
import { readCatalog, effectiveFacts } from './catalog.mjs'

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
 * line; a workspace source still splits per `##` heading for callers that pass
 * one explicitly.
 *
 * Retrieval does NOT use this for workspace files: level-1 workspace documents
 * are name-only (see `wsDoc`), because a section of workspace text in the
 * corpus is exactly what the two-level design keeps out of the prompt.
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

/**
 * First-line title of a workspace file, or `''` when the first line is not a
 * level-1 heading (`# ...`).
 *
 * Only the first physical line counts. Workspace bodies contain `#` lines in
 * quotes and code blocks; scanning the whole file for something that looks
 * like a title would put body text back into the level-1 document.
 *
 * @param {string} text Workspace file contents.
 * @returns {string} Title line, or empty string.
 */
export function wsTitle(text) {
  const first = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0].trim()
  return first.startsWith('# ') && !first.startsWith('## ') ? first : ''
}

/**
 * Level-1 workspace document: file name plus first-line title, never the body.
 *
 * Rationale: at level 1 retrieval may answer "which workspace note might be
 * relevant", not "what does it say". Indexing the body means any unrelated
 * query can pull a whole workspace section into the prompt. Reading the body
 * is an explicit second step (`nb_search.py --file <area>`), which is also why
 * `date` is null here: without a body there is no section date to weight.
 *
 * @param {string} name Workspace file name, e.g. `记忆系统.md`.
 * @param {string} text Workspace file contents.
 * @returns {MemoryDoc} Name-only document.
 */
export function wsDoc(name, text) {
  const source = `ws/${name}`
  const title = wsTitle(text)
  return { source, line: 1, text: title ? `${source}\n${title}` : source, date: null }
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

/**
 * Unavailable or invalid layers are skipped unless strict diagnostics are requested.
 *
 * `core.md` is deliberately **not** part of the retrieval corpus. It is injected
 * in full every turn by `buildCore`, so indexing it here would let the same text
 * consume the prompt budget twice — the exact rule the Python side follows
 * (`nb_search.py` excludes `scope === "core"` by default). A broken `core.md`
 * is still reported by the core-budget check and by `buildCore` throwing, not by
 * pretending it was a retrievable document.
 */
export function loadCorpus(home, { exclude = [], strict = false, includeHistory = false } = {}) {
  const docs = []
  try {
    docs.push(...streamDocs(readLayer(home, 'stream.md')))
  } catch (error) {
    if (strict && error?.name !== 'MissingLayer') throw error
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
      const fileStat = lstatSync(join(wsDir, name))
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        if (strict) throw new Error(`workspace entry must be a regular file: ${name}`)
        continue
      }
      // One name-only document per file. `exclude` stays as an extra guardrail;
      // the real gate is that no workspace body ever enters this corpus.
      const doc = wsDoc(name, readLayer(home, `ws/${name}`))
      docs.push(doc)
    } catch (error) {
      if (strict && error?.name !== 'MissingLayer') throw error
    }
  }
  let catalog
  try { catalog = readCatalog(home, { strict }) }
  catch (error) { console.error(`[memory-dba] ${error.message}`); if (strict) throw error }
  if (catalog) {
    const cards = new Map(catalog.cards.map(card => [card.file, card]))
    for (const doc of docs) {
      const card = cards.get(doc.source)
      if (!card || exclude.includes(doc.source) || exclude.includes(doc.source.slice(3))) continue
      const labels = [['topics','topics'],['aliases','aliases'],['entities','entities'],['questions','questions']]
        .filter(([key]) => card[key].length).map(([key,label]) => `${label}: ${card[key].join(', ')}`)
      if (labels.length) doc.text += `\n${labels.join('\n')}`
    }
    const superseded = new Set(catalog.facts.flatMap(f => f.supersedes))
    const eff = effectiveFacts(catalog, { history: includeHistory })
    for (const fact of eff) {
      if (!includeHistory && fact.effective_status !== 'active' && fact.effective_status !== 'conflict') continue
      const evidence = fact.source.role === 'user' ? 'user_reported' : 'assistant_reported'
      const text = `key: ${fact.key}\nclaim: ${fact.claim}\nkind: ${fact.kind}\nsource: ${evidence}\nevent: ${fact.source.event_id}\nstatus: ${fact.effective_status}`
      docs.push({ source: `fact/${fact.id}`, line: 1, text, date: fact.observed_at, evidence: { ...fact.source }, source_label: evidence, factStatus: fact.effective_status, effective_status: fact.effective_status, conflict: fact.effective_status === 'conflict', key: fact.key, claim: fact.claim, kind: fact.kind, factKey: fact.key, superseded: superseded.has(fact.id) })
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
 * @property {Map<string, number>|null} [semantic] Cosines keyed by document-text SHA-1.
 * @property {number} [semanticMinScore] Cosine floor for appended semantic hits, default 0.45.
 */

/**
 * Rank documents for a query.
 *
 * @param {MemoryDoc[]} docs Corpus.
 * @param {string} query User query.
 * @param {SearchOptions & { topK?: number }} [options]
 * @returns {{ hits: Array<MemoryDoc & { score: number, base: number }>, applied: boolean, corpusDates: {dated: number, undated: number} }}
 */
export function search(docs, query, options = {}) {
  const topK = Math.max(1, options.topK ?? 5)
  const terms = queryTerms(query)
  const empty = { hits: [], applied: false, corpusDates: { dated: 0, undated: 0 } }
  if ((!terms.size && !options.semantic?.size) || !docs.length) return empty

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
  const keys = options.semantic?.size ? docs.map(doc => docKey(doc.text)) : null
  /** Semantic hits extend the keyword list; they never reorder it. */
  const extras = picked => {
    if (!keys) return picked
    const minimum = Number.isFinite(options.semanticMinScore) ? options.semanticMinScore : 0.45
    const seen = new Set(picked.map(hit => docKey(hit.text)))
    const found = []
    for (let index = 0; index < docs.length; index += 1) {
      if (seen.has(keys[index])) continue
      const score = options.semantic.get(keys[index])
      if (Number.isFinite(score) && score >= minimum) found.push({ index, score })
    }
    found.sort((left, right) => right.score - left.score || left.index - right.index)
    return picked.concat(found
      .slice(0, topK)
      .map(({ index, score }) => ({ ...docs[index], score: score * 10, base: score * 10, semantic: true })))
  }
  let ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])
  if (!ranked.length) return { ...empty, hits: extras([]) }

  const base = ranked
    .map(([i, score]) => ({ ...docs[i], score, base: score }))

  const dated = base.filter(hit => hit.date)
  const corpusDates = { dated: dated.length, undated: base.length - dated.length }

  const withinBudget = Number.isFinite(options.budgetBytes)
    && base.reduce((total, hit) => total + bytes(hit.text) + 48, 0) <= options.budgetBytes
  if (!options.timeDecay || !dated.length || withinBudget) {
    return { hits: extras(base.slice(0, topK)), applied: false, corpusDates }
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
    .map((hit, index) => ({ ...hit, weight: weights.get(hit) ?? neutral, docIndex: ranked[index][0] }))
    .sort((left, right) => right.base * right.weight - left.base * left.weight || left.docIndex - right.docIndex)
    .map(({ weight, docIndex, ...hit }) => ({ ...hit, score: hit.base * weight }))

  return { hits: extras(reranked.slice(0, topK)), applied: true, corpusDates, timeWeightNeutral: neutral }
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
