/**
 * Turn-to-stream writer.
 *
 * The stream is a timeline, not a transcript: one line per finished turn, no
 * detail. Anything longer belongs in a workspace note that retrieval can reach.
 * Writing is best-effort — a failed write must never fail the turn.
 */

import { appendLayer, readLayer } from './store.mjs'
import { completeEvent, createPendingEvent, eventId, markEventPublished, readEvent, sanitizeEventText, saveEvent } from './events.mjs'

/** Remove credential-looking runs before text reaches a committable file. */
export const sanitize = sanitizeEventText

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
export function formatTurn({ user, assistant, tag, at, eventId: id }) {
  const u = oneLine(sanitize(user), 300)
  const a = oneLine(sanitize(assistant), 600)
  if (!u || !a) return null
  const label = tag ? ` | tag=${oneLine(sanitize(tag), 100)}` : ''
  return `- ${stamp(at)}${label} | 用户：${u} | 助手：${a}${id ? ` [event=${id}]` : ''}`
}

/** Compact navigation excerpt balanced across both ends of each message. */
export function summarizeForStream(text, maxChars) {
  const flat = oneLine(sanitize(text), Number.MAX_SAFE_INTEGER)
  if (flat.length <= maxChars) return flat
  let head = Math.floor((maxChars - 1) * 0.58)
  const tail = maxChars - 1 - head
  if (head > 0 && /[\uD800-\uDBFF]/.test(flat[head - 1]) && /[\uDC00-\uDFFF]/.test(flat[head])) head -= 1
  let tailStart = flat.length - tail
  if (tailStart > 0 && /[\uD800-\uDBFF]/.test(flat[tailStart - 1]) && /[\uDC00-\uDFFF]/.test(flat[tailStart])) tailStart += 1
  return `${flat.slice(0, head)}…${flat.slice(tailStart)}`
}

/** Publish one completed archive; the reference makes append recovery idempotent. */
export function publishEvent(home, id, options = {}) {
  const event = readEvent(home, id)
  if (!event || event.status !== 'complete') return { written: false, reason: 'not-complete' }
  let stream = ''
  try { stream = readLayer(home, 'stream.md') } catch (error) { if (error?.name !== 'MissingLayer') throw error }
  if (stream.includes(`[event=${id}]`)) {
    markEventPublished(home, id)
    return { written: false, reason: 'already-published' }
  }
  const tag = options.tag ?? event.tag ?? ''
  const line = formatTurn({ user: summarizeForStream(event.user, 300), assistant: summarizeForStream(event.assistant, 600), tag, at: new Date(event.started_at), eventId: id })
  if (!line) return { written: false, reason: 'empty-turn' }
  appendLayer(home, 'stream.md', line)
  markEventPublished(home, id)
  return { written: true, line }
}

/**
 * Append a turn unless it repeats the last line.
 *
 * @param {string} home Memory directory.
 * @param {{user?: string, assistant?: string, tag?: string, at?: Date}} turn
 * @returns {{written: boolean, reason?: string, line?: string}}
 */
export function appendTurn(home, turn) {
  if (!turn?.user || !turn?.assistant) return { written: false, reason: 'empty-turn' }
  const at = turn.at ? new Date(turn.at) : new Date()
  const digest = String(turn.eventId || eventId())
  if (!turn.eventId) {
    const wanted = formatTurn({ ...turn, at, user: summarizeForStream(turn.user, 300), assistant: summarizeForStream(turn.assistant, 600) }).replace(/\s+$/, '')
    try {
      const stream = readLayer(home, 'stream.md').trimEnd()
      const lastLine = stream.slice(stream.lastIndexOf('\n') + 1)
      const priorId = / \[event=([A-Za-z0-9_-]+)\]$/.exec(lastLine)?.[1]
      const last = lastLine.replace(/ \[event=[A-Za-z0-9_-]+\]$/, '')
      if (last === wanted) {
        const prior = priorId ? readEvent(home, priorId) : null
        const sameArchive = prior && prior.user === sanitize(turn.user) && prior.assistant === sanitize(turn.assistant)
        const legacyShort = !priorId && String(turn.user).length <= 300 && String(turn.assistant).length <= 600
        if (sameArchive || legacyShort) return { written: false, reason: 'duplicate' }
      }
    } catch (error) { if (error?.name !== 'MissingLayer') throw error }
  }
  let event = readEvent(home, digest)
  if (!event) {
    event = createPendingEvent(home, { id: digest, session_id: turn.session_id || 'cli', user: turn.user, at, tag: turn.tag })
    event.assistant = sanitize(turn.assistant)
    event.updated_at = new Date().toISOString()
    saveEvent(home, event)
    completeEvent(home, event.id)
  } else if (event.status !== 'complete') {
    event.assistant = sanitize(turn.assistant)
    event.updated_at = new Date().toISOString()
    saveEvent(home, event)
    completeEvent(home, event.id)
  }
  const result = publishEvent(home, event.id, { tag: turn.tag })
  return result.reason === 'already-published' ? { ...result, reason: 'duplicate' } : result
}
