import assert from 'node:assert/strict'
import fs, { mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { after, mock, test } from 'node:test'
import { buildCore, buildHits } from '../src/assemble.mjs'
import { apply } from '../src/index.mjs'
import { loadCorpus, search, splitDocs, STREAM_MAX_BYTES, STREAM_MAX_DOCS } from '../src/search.mjs'
import { bytes, clipBytes, ensureLayout, fingerprint, readLayer } from '../src/store.mjs'
import { formatTurn, oneLine, sanitize } from '../src/stream.mjs'

const homes = []
function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'dba-regression-'))
  homes.push(home)
  return home
}
after(() => homes.forEach(home => rmSync(home, { recursive: true, force: true })))

function plugin(home, config = {}) {
  const sections = []
  const handlers = new Map()
  apply({
    on: (name, handler) => handlers.set(name, handler),
    systemPrompt: { section: section => sections.push(section) },
  }, { home, ...config })
  return {
    sections,
    event: (id, event) => handlers.get('session/event')({ id }, event),
    user: (id, text) => handlers.get('session/event')({ id }, {
      type: 'user/message', data: { source: { kind: 'user' }, content: text },
    }),
    hits: () => sections[1].text(),
    dispose: id => handlers.get('session/disposed')({ id }),
  }
}

test('workspace edits, additions, removals and renames invalidate cached retrieval', () => {
  const home = tempHome()
  ensureLayout(home)
  const file = join(home, 'ws', 'note.md')
  writeFileSync(file, 'needle before')
  const runtime = plugin(home)
  runtime.user('one', 'needle')
  assert.match(runtime.hits('one'), /before/)
  let previous = fingerprint(home)
  writeFileSync(file, 'needle after!')
  utimesSync(file, new Date(), new Date(Date.now() + 2000))
  assert.notEqual(fingerprint(home), previous)
  runtime.user('one', 'needle')
  assert.match(runtime.hits('one'), /after!/)
  previous = fingerprint(home)
  renameSync(file, join(home, 'ws', 'renamed.md'))
  assert.notEqual(fingerprint(home), previous)
  runtime.user('one', 'needle')
  assert.match(runtime.hits('one'), /ws\/renamed.md/)
  previous = fingerprint(home)
  writeFileSync(file, 'unique additional memory')
  assert.notEqual(fingerprint(home), previous)
  runtime.user('one', 'unique')
  assert.match(runtime.hits('one'), /additional/)
  rmSync(file)
  runtime.user('one', 'unique')
  assert.equal(runtime.hits('one'), '')
})

test('prompt hits follow the most recent user turn', () => {
  const home = tempHome()
  ensureLayout(home)
  writeFileSync(join(home, 'ws', 'notes.md'), 'alpha private apples\n\nbeta private bananas')
  const runtime = plugin(home)
  runtime.user('one', 'alpha')
  assert.match(runtime.hits(), /apples/)
  assert.doesNotMatch(runtime.hits(), /bananas/)
  runtime.user('two', 'beta')
  assert.match(runtime.hits(), /bananas/)
  assert.doesNotMatch(runtime.hits(), /apples/)
  // Disposal frees the pending turn, not the recall slot: the slot is not session state.
  runtime.dispose('two')
  assert.match(runtime.hits(), /bananas/)
})

test('workspace headings keep physical line numbers across consecutive flushes', () => {
  const docs = splitDocs('\uFEFFintro\r\n## First\r\nbody\r\n## Second\r\nbody\r\n\r\n\r\n## Third\r\nlast', 'ws/note.md')
  assert.deepEqual(docs.map(doc => doc.line), [1, 2, 4, 8])
  assert.match(docs[2].text, /^## Second\nbody$/)
  for (const source of ['core', 'stream']) {
    const lines = splitDocs('first\nsecond\n\nthird', source)
    assert.deepEqual(lines.map(doc => [doc.line, doc.text]), [[1, 'first'], [2, 'second'], [4, 'third']])
  }
})

test('recency reranking respects the configured candidate byte budget', () => {
  const docs = splitDocs('2026-01-01 deploy old\n2026-10-20 deploy recent', 'stream')
  const options = { timeDecay: true, now: '2026-10-26', halfLifeDays: 30 }
  const fits = search(docs, 'deploy', { ...options, budgetBytes: 1024 })
  assert.equal(fits.applied, false)
  const overflows = search(docs, 'deploy', { ...options, budgetBytes: 1 })
  assert.equal(overflows.applied, true)
  assert.match(overflows.hits[0].text, /recent/)
})

test('sanitization preserves ordinary dates, timestamps, CJK and emoji', () => {
  const text = '日期2026-10-26 时间2026-10-26T12:34:56.789Z，2026/10/26 12:34，学号202301233055，时钟😀'
  assert.equal(sanitize(text), text)
  assert.equal(sanitize('中文1234567890123456后续'), '中文[redacted]后续')
  const line = formatTurn({ user: text, assistant: '保留中文😀', at: new Date(2026, 9, 26, 12, 34) })
  assert.match(line, /2026-10-26 12:34/)
  assert.match(line, /中文😀/)
})

test('byte clipping accounts for short caps, multi-byte markers, and emoji', () => {
  for (let cap = 0; cap < 80; cap += 1) {
    for (const marker of [undefined, '😀尾', '']) {
      const out = clipBytes('😀记忆'.repeat(100), cap, marker)
      assert.ok(bytes(out.text) <= cap, `cap ${cap}`)
      assert.equal(out.text.isWellFormed(), true)
      assert.equal(out.clipped, true)
    }
  }
  assert.deepEqual(clipBytes('😀', 4), { text: '😀', clipped: false })
  assert.equal(oneLine('ab😀next', 4), 'ab…')
  assert.equal(oneLine('ab😀next', 5), 'ab😀…')
})

test('prompt budgets include brace escaping overhead', () => {
  const home = tempHome()
  ensureLayout(home)
  writeFileSync(join(home, 'core.md'), '{{'.repeat(500))
  const core = buildCore(home, { coreLimitKB: 1 })
  const hits = buildHits([{ source: 'core', line: 1, text: '{{'.repeat(500) }], { budgetKB: 1 })
  for (const section of [core, hits]) {
    assert.equal(section.clipped, true)
    assert.ok(bytes(section.text) <= 1024)
    assert.ok(!section.text.includes('{{'))
  }
})

test('core prompt reflects edits within a session instead of caching stale text', () => {
  const home = tempHome()
  ensureLayout(home)
  const runtime = plugin(home)
  assert.match(runtime.sections[0].text(), /Core memory/)
  writeFileSync(join(home, 'core.md'), 'updated core')
  assert.equal(runtime.sections[0].text(), 'updated core')
  writeFileSync(join(home, 'core.md'), Buffer.from([0xff]))
  assert.equal(runtime.sections[0].text(), '')
})

test('tags cannot bypass stream sanitization or introduce extra lines', () => {
  const line = formatTurn({ user: 'question', assistant: 'answer', tag: '中文\nBearer abcdefghijklmnopq' })
  assert.ok(!line.includes('\n'))
  assert.match(line, /tag=中文 \[redacted\]/)
})

test('invalid UTF-8 is rejected, skipped in recall, and never breaks prompt assembly', () => {
  const home = tempHome()
  ensureLayout(home)
  for (const file of ['core.md', 'stream.md', 'ws/broken.md']) {
    writeFileSync(join(home, file), Buffer.from([0xc3, 0x28]))
    assert.throws(() => readLayer(home, file), /encoded data/)
  }
  writeFileSync(join(home, 'ws', 'valid.md'), 'valid searchable memory')
  const docs = loadCorpus(home)
  assert.equal(docs.length, 1)
  assert.equal(docs[0].source, 'ws/valid.md')
  assert.throws(() => loadCorpus(home, { strict: true }), /encoded data/)
  const runtime = plugin(home)
  assert.equal(runtime.sections[0].text(), '')
  runtime.user('one', 'searchable')
  assert.match(runtime.hits('one'), /searchable/)
})

test('an unreadable home degrades safely and clears previously recalled hits', () => {
  const home = tempHome()
  ensureLayout(home)
  writeFileSync(join(home, 'ws', 'valid.md'), 'needle memory')
  const runtime = plugin(home)
  runtime.user('one', 'needle')
  assert.match(runtime.hits('one'), /needle/)
  const originals = new Map()
  const mocks = []
  for (const name of ['readFileSync', 'readdirSync', 'statSync', 'mkdirSync']) {
    originals.set(name, fs[name])
    mocks.push(mock.method(fs, name, (file, ...args) => {
      if (String(file) === home || String(file).startsWith(`${home}${sep}`)) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      return originals.get(name)(file, ...args)
    }))
  }
  const errors = mock.method(console, 'error', () => {})
  syncBuiltinESMExports()
  try {
    runtime.user('one', 'needle')
    assert.equal(runtime.hits('one'), '')
    assert.equal(runtime.sections[0].text(), '')
    assert.deepEqual(loadCorpus(home), [])
    assert.throws(() => loadCorpus(home, { strict: true }), /permission denied/)
    const inaccessible = plugin(home)
    assert.equal(inaccessible.sections[0].text(), '')
  } finally {
    mocks.forEach(method => method.mock.restore())
    errors.mock.restore()
    syncBuiltinESMExports()
  }
})

test('read-only home keeps recall working while persistence fails safely', () => {
  const home = tempHome()
  ensureLayout(home)
  writeFileSync(join(home, 'ws', 'valid.md'), 'needle memory')
  const original = fs.writeFileSync
  const writes = mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file).startsWith(`${home}${sep}`)) throw Object.assign(new Error('read-only filesystem'), { code: 'EROFS' })
    return original(file, ...args)
  })
  const errors = mock.method(console, 'error', () => {})
  syncBuiltinESMExports()
  try {
    const runtime = plugin(home)
    runtime.user('one', 'needle')
    assert.match(runtime.hits('one'), /needle/)
    runtime.event('one', { type: 'assistant/message', data: { message: { content: 'answer' } } })
    assert.doesNotThrow(() => runtime.event('one', { type: 'turn/end' }))
    assert.ok(errors.mock.calls.some(call => call.arguments[0].includes('read-only filesystem')))
    assert.equal(readFileSync(join(home, 'stream.md'), 'utf8'), '# Memory stream\n\n')
  } finally {
    writes.mock.restore()
    errors.mock.restore()
    syncBuiltinESMExports()
  }
})

test('5MB stream retrieval is bounded and retains exact recent line references', context => {
  const home = tempHome()
  ensureLayout(home)
  const entry = '- 2026-10-26 12:30 用户：排查时钟偏移 retrieval benchmark clock offset token\n'
  const count = Math.ceil(5 * 1024 * 1024 / bytes(entry))
  writeFileSync(join(home, 'stream.md'), `${entry.repeat(count)}latestneedle recent note\n`)
  const start = performance.now()
  const docs = loadCorpus(home)
  const result = search(docs, 'latestneedle 时钟 clock')
  const elapsed = performance.now() - start
  const stream = docs.filter(doc => doc.source === 'stream')
  assert.ok(stream.length <= STREAM_MAX_DOCS)
  assert.ok(stream.reduce((total, doc) => total + bytes(doc.text), 0) <= STREAM_MAX_BYTES)
  assert.equal(stream.at(-1).line, count + 1)
  assert.ok(result.hits.some(hit => hit.text.includes('latestneedle')))
  context.diagnostic(`5MB cold load + search: ${elapsed.toFixed(1)}ms, ${stream.length} stream docs`)
  assert.ok(elapsed < 300, `retrieval took ${elapsed.toFixed(1)}ms`)
})

test('stream byte cap skips oversized entries without fabricating line numbers', () => {
  const home = tempHome()
  ensureLayout(home)
  writeFileSync(join(home, 'stream.md'), `old\n${'x'.repeat(STREAM_MAX_BYTES + 1)}\nnew\n`)
  assert.deepEqual(loadCorpus(home).filter(doc => doc.source === 'stream').map(doc => doc.line), [1, 3])
})

let cliRun = 0
async function cli(args) {
  const argv = process.argv
  const exitCode = process.exitCode
  const output = []
  const errors = []
  const log = mock.method(console, 'log', (...parts) => output.push(parts.join(' ')))
  const error = mock.method(console, 'error', (...parts) => errors.push(parts.join(' ')))
  try {
    process.argv = [argv[0], 'cli.mjs', ...args]
    process.exitCode = 0
    await import(`../bin/cli.mjs?run=${cliRun += 1}`)
    return { code: process.exitCode, text: [...output, ...errors].join('\n') }
  } finally {
    process.argv = argv
    process.exitCode = exitCode
    log.mock.restore()
    error.mock.restore()
  }
}

test('CLI usage and parse failures return non-zero without stack traces', async () => {
  const home = tempHome()
  for (const args of [[], ['unknown'], ['--unknown'], ['--home'], ['recall'], ['recall', '   '], ['recall', '!!!'], ['recall', 'clock', '--top-k', 'NaN']]) {
    const result = await cli([...args, ...(['--home'].includes(args.at(-1)) ? [] : ['--home', home])])
    assert.notEqual(result.code, 0, args.join(' '))
    assert.doesNotMatch(result.text, /\n\s+at |ERR_PARSE_ARGS|file:\/\//)
  }
})

test('CLI doctor succeeds on a fresh home and reports broken homes without stacks', async () => {
  const home = tempHome()
  const fresh = await cli(['doctor', '--home', home])
  assert.equal(fresh.code, 0)
  assert.match(fresh.text, /ok\s+retrieval/)
  writeFileSync(join(home, 'core.md'), Buffer.from([0xff]))
  const corrupt = await cli(['doctor', '--home', home])
  assert.notEqual(corrupt.code, 0)
  assert.match(corrupt.text, /FAIL core-budget/)
  assert.match(corrupt.text, /FAIL corpus/)
  assert.doesNotMatch(corrupt.text, /\n\s+at /)
  const blocked = join(tempHome(), 'not-a-directory')
  writeFileSync(blocked, 'file')
  const broken = await cli(['doctor', '--home', blocked, '--json'])
  assert.notEqual(broken.code, 0)
  const report = JSON.parse(broken.text)
  assert.equal(report.ok, false)
  assert.ok(report.checks.some(check => check.name === 'layout' && !check.ok))
})
