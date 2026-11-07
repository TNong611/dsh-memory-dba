import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { completeEvent, createPendingEvent, readEvent, updateEventAssistant } from '../src/events.mjs'
import { appendTurn, publishEvent, summarizeForStream } from '../src/stream.mjs'
import { ensureLayout } from '../src/store.mjs'
import { apply } from '../src/index.mjs'

function home() { const dir = mkdtempSync(join(tmpdir(), 'dba-events-')); ensureLayout(dir); return dir }
function cleanup(dir) { rmSync(dir, { recursive: true, force: true }) }

test('full event archive retains long-tail negation and result; stream is a short navigation reference', () => {
  const dir = home()
  try {
    const user = `前文${'问题'.repeat(500)}\n结果：尾部否定并未完成，不能视为已修复。`
    const assistant = `开头${'说明'.repeat(800)}\n结果：确认仍未完成。`
    const event = createPendingEvent(dir, { session_id: 'session-a', user })
    updateEventAssistant(dir, event.id, assistant)
    completeEvent(dir, event.id)
    publishEvent(dir, event.id)
    const archived = readEvent(dir, event.id)
    assert.equal(archived.user, user)
    assert.equal(archived.assistant, assistant)
    assert.ok(archived.observations.every(item => item.status === 'candidate'))
    const stream = readFileSync(join(dir, 'stream.md'), 'utf8')
    assert.match(stream, new RegExp(`\\[event=${event.id}\\]`))
    assert.match(stream, /尾部否定并未完成/)
    assert.ok(stream.length < user.length + assistant.length)
  } finally { cleanup(dir) }
})

test('archives are isolated by session and pending survives process loss without replay', () => {
  const dir = home()
  try {
    const a = createPendingEvent(dir, { session_id: 'a', user: 'question a' })
    const b = createPendingEvent(dir, { session_id: 'b', user: 'question b' })
    updateEventAssistant(dir, a.id, 'answer a')
    assert.equal(readEvent(dir, a.id).status, 'pending')
    assert.equal(readdirSync(join(dir, 'events-v1')).filter(name => name.endsWith('.json')).length, 2)
    assert.equal(readEvent(dir, b.id).assistant, '')
    assert.equal(readFileSync(join(dir, 'stream.md'), 'utf8').includes('[event='), false)
  } finally { cleanup(dir) }
})

test('recovery is idempotent, including append-before-marker crash window', () => {
  const dir = home()
  try {
    const event = createPendingEvent(dir, { session_id: 'reboot', user: 'q' })
    updateEventAssistant(dir, event.id, 'a')
    completeEvent(dir, event.id)
    publishEvent(dir, event.id)
    let archived = readEvent(dir, event.id)
    archived.stream_written = false
    // Simulate crash after stream append but before archive marker persisted.
    const archivePath = join(dir, 'events-v1', `${event.id}.json`)
    writeFileSync(archivePath, `${JSON.stringify(archived)}\n`)
    assert.equal(publishEvent(dir, event.id).reason, 'already-published')
    assert.equal(readEvent(dir, event.id).stream_written, true)
    assert.equal(readFileSync(join(dir, 'stream.md'), 'utf8').split(`[event=${event.id}]`).length - 1, 1)
  } finally { cleanup(dir) }
})

test('a completed archive remains recoverable after stream append fails', () => {
  const dir = home()
  try {
    const event = createPendingEvent(dir, { session_id: 'retry', user: 'q' })
    updateEventAssistant(dir, event.id, 'a')
    completeEvent(dir, event.id)
    const streamPath = join(dir, 'stream.md')
    const backup = join(dir, 'stream.backup')
    renameSync(streamPath, backup)
    mkdirSync(streamPath)
    assert.throws(() => publishEvent(dir, event.id), /EISDIR|directory/i)
    assert.equal(readEvent(dir, event.id).status, 'complete')
    assert.equal(readEvent(dir, event.id).stream_written, false)
    rmSync(streamPath, { recursive: true })
    renameSync(backup, streamPath)
    assert.equal(publishEvent(dir, event.id).written, true)
    assert.equal(publishEvent(dir, event.id).reason, 'already-published')
  } finally { cleanup(dir) }
})

test('mock session lifecycle persists pending, completes, and restart recovers publication', () => {
  const dir = home()
  try {
    const handlers = new Map()
    const ctx = { on: (key, handler) => handlers.set(key, handler), systemPrompt: { section() {}, context() {} } }
    apply(ctx, { home: dir })
    const send = handlers.get('session/event')
    send({ id: 'live-session' }, { type: 'user/message', data: { source: { kind: 'user' }, content: 'user question' } })
    let files = readdirSync(join(dir, 'events-v1')).filter(name => name.endsWith('.json'))
    assert.equal(files.length, 1)
    const id = files[0].slice(0, -5)
    assert.equal(readEvent(dir, id).status, 'pending')
    send({ id: 'live-session' }, { type: 'assistant/message', data: { message: { content: 'assistant answer' } } })
    assert.equal(readEvent(dir, id).assistant, 'assistant answer')

    const streamPath = join(dir, 'stream.md')
    const backup = join(dir, 'stream.backup')
    renameSync(streamPath, backup)
    mkdirSync(streamPath)
    send({ id: 'live-session' }, { type: 'turn/end' })
    assert.equal(readEvent(dir, id).status, 'complete')
    assert.equal(readEvent(dir, id).stream_written, false)
    rmSync(streamPath, { recursive: true })
    renameSync(backup, streamPath)

    const restarted = new Map()
    const ctx2 = { on: (key, handler) => restarted.set(key, handler), systemPrompt: { section() {}, context() {} } }
    apply(ctx2, { home: dir })
    assert.equal(readEvent(dir, id).stream_written, true)
    assert.match(readFileSync(streamPath, 'utf8'), new RegExp(`\\[event=${id}\\]`))
    assert.equal(readdirSync(join(dir, 'events-v1', 'outbox')).length, 0)
  } finally { cleanup(dir) }
})

test('stream summary keeps surrogate pairs intact and writeStream=false creates no archive', () => {
  const summary = summarizeForStream(`${'x'.repeat(170)}😀${'y'.repeat(170)}`, 200)
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(summary), false)
  const dir = home()
  try {
    const handlers = new Map()
    const ctx = { on: (key, handler) => handlers.set(key, handler), systemPrompt: { section() {}, context() {} } }
    apply(ctx, { home: dir, writeStream: false })
    const send = handlers.get('session/event')
    send({ id: 'no-archive' }, { type: 'user/message', data: { source: { kind: 'user' }, content: 'q' } })
    send({ id: 'no-archive' }, { type: 'assistant/message', data: { message: { content: 'a' } } })
    send({ id: 'no-archive' }, { type: 'turn/end' })
    assert.equal(existsSync(join(dir, 'events-v1')), false)
    assert.equal(readFileSync(join(dir, 'stream.md'), 'utf8'), '# Memory stream\n\n')
  } finally { cleanup(dir) }
})

test('equal navigation excerpts do not deduplicate different full messages', () => {
  const dir = home()
  try {
    const at = new Date('2026-11-04T00:00:00Z')
    const first = `${'开头'.repeat(200)}中间事实甲${'末尾'.repeat(200)}`
    const second = `${'开头'.repeat(200)}中间事实乙${'末尾'.repeat(200)}`
    assert.equal(summarizeForStream(first, 300), summarizeForStream(second, 300))
    assert.equal(appendTurn(dir, { user: first, assistant: 'received', at }).written, true)
    assert.equal(appendTurn(dir, { user: second, assistant: 'received', at }).written, true)
    assert.equal(appendTurn(dir, { user: second, assistant: 'received', at }).reason, 'duplicate')
    assert.equal(readdirSync(join(dir, 'events-v1')).filter(n => n.endsWith('.json')).length, 2)
  } finally { cleanup(dir) }
})

test('completion flushes all text after a missed intermediate draft update', () => {
  const dir = home()
  try {
    const event = createPendingEvent(dir, { session_id: 'final-flush', user: 'q' })
    updateEventAssistant(dir, event.id, 'work started')
    completeEvent(dir, event.id, { user: 'q', assistant: 'work started\n结果：失败，尚未完成。' })
    assert.match(readEvent(dir, event.id).assistant, /失败，尚未完成/)
    assert.equal(readEvent(dir, event.id).observations[0].status, 'candidate')
  } finally { cleanup(dir) }
})
