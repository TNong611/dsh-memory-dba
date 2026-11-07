/** Complete, sanitized turn archives with recoverable stream publication. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b\d{13,19}\b/g,
]
export function sanitizeEventText(text) {
  let out = String(text || '')
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]')
  return out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

export function eventId() { return randomUUID().replaceAll('-', '') }
function fileFor(home, id) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(id))) throw new Error('invalid event id')
  const dir = join(home, 'events-v1')
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error('event directory cannot be a symbolic link')
  const path = join(dir, `${id}.json`)
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('event file cannot be a symbolic link')
  return path
}
function atomicJson(path, event) {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  if (lstatSync(dir).isSymbolicLink()) throw new Error('event storage directory cannot be a symbolic link')
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(tmp, `${JSON.stringify(event, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    renameSync(tmp, path)
  } finally {
    try { unlinkSync(tmp) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
}
export function saveEvent(home, event) { atomicJson(fileFor(home, event.id), event); return event }
export function readEvent(home, id) {
  try {
    const event = JSON.parse(readFileSync(fileFor(home, id), 'utf8'))
    if (!validEvent(event, id)) throw new Error(`invalid event schema: ${id}`)
    return event
  }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}
function validEvent(event, id) {
  return event && event.version === 1 && event.id === id && typeof event.session_id === 'string'
    && typeof event.started_at === 'string' && Number.isFinite(Date.parse(event.started_at))
    && typeof event.updated_at === 'string' && Number.isFinite(Date.parse(event.updated_at))
    && ['pending', 'complete', 'interrupted'].includes(event.status)
    && typeof event.user === 'string' && typeof event.assistant === 'string'
    && Array.isArray(event.observations) && event.observations.every(item => item
      && ['user', 'assistant'].includes(item.role) && ['决定', '约束', '结果', '计划', '纠正'].includes(item.kind)
      && typeof item.quote === 'string' && ['reported', 'candidate'].includes(item.status))
    && typeof event.stream_written === 'boolean'
}
function outboxDir(home) { return join(home, 'events-v1', 'outbox') }
function enqueue(home, id) {
  atomicJson(join(outboxDir(home), `${id}.json`), { version: 1, id })
}
export function removeOutbox(home, id) {
  fileFor(home, id)
  const dir = outboxDir(home)
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error('outbox directory cannot be a symbolic link')
  const path = join(dir, `${id}.json`)
  try { if (lstatSync(path).isSymbolicLink()) throw new Error('outbox file cannot be a symbolic link'); unlinkSync(path) }
  catch (error) { if (error?.code !== 'ENOENT') throw error }
}
export function createPendingEvent(home, { session_id, user, at = new Date(), id = eventId(), tag = '' }) {
  const started_at = new Date(at).toISOString()
  return saveEvent(home, { version: 1, id, session_id: String(session_id || ''), started_at, updated_at: started_at, status: 'pending', user: sanitizeEventText(user), assistant: '', observations: [], stream_written: false, tag: sanitizeEventText(tag) })
}
export function updateEventAssistant(home, id, text) {
  const event = readEvent(home, id)
  if (!event || event.status !== 'pending') return event
  const clean = sanitizeEventText(text)
  event.assistant = event.assistant ? `${event.assistant}\n${clean}` : clean
  event.observations = extractObservations(event.user, event.assistant)
  event.updated_at = new Date().toISOString()
  return saveEvent(home, event)
}
export function extractObservations(user, assistant) {
  const result = []
  for (const [role, text] of [['user', user], ['assistant', assistant]]) {
    for (const line of String(text || '').split(/\r?\n/)) {
      const m = line.match(/^\s*(决定|约束|结果|计划|纠正)\s*[:：]\s*(.+?)\s*$/)
      if (m) result.push({ role, kind: m[1], quote: m[2], status: 'candidate' })
    }
  }
  return result
}
export function completeEvent(home, id, finalText = {}) {
  const event = readEvent(home, id)
  if (!event) return null
  // Flush the complete in-memory messages again in case an intermediate
  // assistant-message write failed temporarily. Never mark a partial draft done.
  if (typeof finalText.user === 'string') event.user = sanitizeEventText(finalText.user)
  if (typeof finalText.assistant === 'string') event.assistant = sanitizeEventText(finalText.assistant)
  // Queue the lightweight reference first. A crash here may leave a stale queue
  // item; recovery leaves a pending archive untouched rather than replaying it.
  enqueue(home, id)
  event.status = 'complete'
  event.updated_at = new Date().toISOString()
  event.observations = extractObservations(event.user, event.assistant)
  return saveEvent(home, event)
}
export function interruptEvent(home, id) {
  const event = readEvent(home, id)
  if (!event || event.status !== 'pending') return event
  event.status = 'interrupted'
  event.updated_at = new Date().toISOString()
  event.observations = extractObservations(event.user, event.assistant)
  return saveEvent(home, event)
}
export function markEventPublished(home, id) {
  const event = readEvent(home, id)
  if (!event) return null
  event.stream_written = true
  event.updated_at = new Date().toISOString()
  const saved = saveEvent(home, event)
  removeOutbox(home, id)
  return saved
}
export function listOutbox(home) {
  const dir = outboxDir(home)
  if (!existsSync(dir)) return []
  if (lstatSync(dir).isSymbolicLink()) throw new Error('outbox directory cannot be a symbolic link')
  return readdirSync(dir).filter(n => /^[A-Za-z0-9_-]{1,128}\.json$/.test(n)).map(n => {
    try {
      const path = join(dir, n)
      if (lstatSync(path).isSymbolicLink()) return null
      const ref = JSON.parse(readFileSync(path, 'utf8'))
      return ref?.version === 1 && ref.id === n.slice(0, -5) ? ref.id : null
    } catch { return null }
  }).filter(Boolean)
}
