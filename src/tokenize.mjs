/**
 * Tokenizer for mixed Chinese/English memory text.
 *
 * A trigram index cannot answer two-character Chinese words (a two-character
 * query is shorter than one trigram), so CJK runs emit both unigrams and
 * bigrams. Latin/digit runs stay whole words, which keeps identifiers such as
 * `202301233055` searchable while ordinary words still match exactly.
 */

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/
const WORD = /[A-Za-z0-9_@.\-]+/g
const CJK_RUN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]+/g

/**
 * Tokens for indexing and querying. Lowercases Latin text, keeps digits and
 * CJK as-is, and deduplicates nothing (term frequency comes from repetition).
 *
 * @param {string} text Raw memory or query text.
 * @returns {string[]} Tokens in source order.
 */
export function tokenize(text) {
  const tokens = []
  if (!text) return tokens
  const lower = String(text).toLowerCase()

  for (const match of lower.matchAll(CJK_RUN)) {
    const run = match[0]
    for (let i = 0; i < run.length; i += 1) {
      tokens.push(run[i])
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2))
    }
  }

  const withoutCjk = lower.replace(CJK_RUN, ' ')
  for (const match of withoutCjk.matchAll(WORD)) {
    const word = match[0].replace(/^[-.]+|[-.]+$/g, '')
    if (word) tokens.push(word)
  }
  return tokens
}

/**
 * Query terms with per-term weight. CJK bigrams carry the most signal, single
 * characters the least; a bare digit string is exact-match material.
 *
 * @param {string} query User query text.
 * @returns {Map<string, number>} term -> boost
 */
export function queryTerms(query) {
  const weights = new Map()
  const bump = (term, weight) => {
    if (!term) return
    weights.set(term, Math.max(weights.get(term) || 0, weight))
  }
  const lower = String(query || '').toLowerCase()

  for (const match of lower.matchAll(CJK_RUN)) {
    const run = match[0]
    if (run.length === 1) bump(run, 1)
    for (let i = 0; i < run.length - 1; i += 1) bump(run.slice(i, i + 2), 1.6)
  }
  for (const match of lower.replace(CJK_RUN, ' ').matchAll(WORD)) {
    const word = match[0].replace(/^[-.]+|[-.]+$/g, '')
    if (!word) continue
    bump(word, /\d{4,}/.test(word) ? 2 : 1.2)
  }
  return weights
}

/** True when the query contains no indexable term at all. */
export function isBlankQuery(query) {
  return queryTerms(query).size === 0
}
