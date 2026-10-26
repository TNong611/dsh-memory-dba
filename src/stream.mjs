/**
 * Turn-to-stream writer.
 *
 * The stream is a timeline, not a transcript: one line per finished turn, no
 * detail. Anything longer belongs in a workspace note that retrieval can reach.
 * Writing is best-effort — a failed write must never fail the turn.
 */

import { appendLayer, readLayer } from './store.mjs'

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b\d{13,19}\b/g,
]

/** Remove credential-looking runs before text reaches a committable file. */
export function sanitize(text) {
  let out = String(text || '')
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]')
  return out
}

/** Collapse whitespace so one turn stays one line. */
export function oneLine(text, maxChars = 600) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  let end = Math.max(0, maxChars - 1)
  if (end > 0 && /[\uD800-\uDBFF]/.test(flat[end - 1]) && /[\uDC00-\uDFFF]/.test(flat[end])) end -= 1
  return `${flat.slice(0, end)}…`
}

/** Local `YYYY-MM-DD HH:mm` timestamp. */
export function stamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Format one turn as a stream line.
 *
 * @param {{user?: string, assistant?: string, tag?: string, at?: Date}} turn
 * @returns {string|null} Line, or null when the turn is not worth remembering.
 */
export function formatTurn({ user, assistant, tag, at }) {
  const u = oneLine(sanitize(user), 300)
  const a = oneLine(sanitize(assistant), 600)
  if (!u || !a) return null
  const label = tag ? ` | tag=${oneLine(sanitize(tag), 100)}` : ''
  return `- ${stamp(at)}${label} | 用户：${u} | 助手：${a}`
}

/**
 * Append a turn unless it repeats the last line.
 *
 * @param {string} home Memory directory.
 * @param {{user?: string, assistant?: string, tag?: string, at?: Date}} turn
 * @returns {{written: boolean, reason?: string, line?: string}}
 */
export function appendTurn(home, turn) {
  const line = formatTurn(turn)
  if (!line) return { written: false, reason: 'empty-turn' }
  let last = ''
  try {
    const stream = readLayer(home, 'stream.md').trimEnd()
    last = stream.slice(stream.lastIndexOf('\n') + 1)
  } catch (error) {
    if (error?.name !== 'MissingLayer') throw error
  }
  if (last === line) return { written: false, reason: 'duplicate' }
  appendLayer(home, 'stream.md', line)
  return { written: true, line }
}
