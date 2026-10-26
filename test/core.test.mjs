import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { buildCore, buildHits, escapeBraces } from '../src/assemble.mjs'
import { apply } from '../src/index.mjs'
import { fitHits, search, splitDocs } from '../src/search.mjs'
import { appendLayer, bytes, clipBytes, ensureLayout } from '../src/store.mjs'
import { appendTurn, formatTurn, sanitize } from '../src/stream.mjs'
import { queryTerms, tokenize } from '../src/tokenize.mjs'

const dirs = []
const tempHome = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dba-test-'))
  dirs.push(dir)
  return dir
}
after(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })))

test('tokenize keeps identifiers and emits CJK unigrams and bigrams', () => {
  const tokens = tokenize('学号 202301233055 时钟慢 8h')
  assert.ok(tokens.includes('202301233055'))
  assert.ok(tokens.includes('时钟'))
  assert.ok(tokens.includes('钟慢'))
  assert.ok(tokens.includes('时'))
  assert.ok(tokens.includes('8h'))
})

test('queryTerms weights a bigram above a single character', () => {
  assert.ok(queryTerms('时钟').get('时钟') > queryTerms('时').get('时'))
})

test('splitDocs separates workspace headings while core stays per line', () => {
  const ws = splitDocs('## A\nfirst body\n\n## B\nsecond body\n', 'ws/notes.md')
  assert.equal(ws.length, 2)
  assert.match(ws[0].text, /## A/)
  const core = splitDocs('line one\n\nline two\n', 'core')
  assert.equal(core.length, 2)
})

test('search ranks the matching note first and reports dated corpus', () => {
  const home = tempHome()
  ensureLayout(home)
  writeFileSync(join(home, 'core.md'), '# Core\n\n- user prefers direct answers\n- clock drifts after dual boot\n- 双系统时钟慢八小时\n', 'utf8')
  writeFileSync(join(home, 'stream.md'), '- 2026-10-22 22:48 修复双系统时钟慢8h\n', 'utf8')
  const docs = splitDocs(readFileSync(join(home, 'core.md'), 'utf8'), 'core')
  const result = search(docs, 'clock drift', { topK: 2 })
  assert.equal(result.hits.length, 1)
  assert.match(result.hits[0].text, /clock/)

  const zh = search(docs, '时钟慢', { topK: 2 })
  assert.match(zh.hits[0].text, /双系统时钟慢/)
})

test('time decay reranks without dropping relevance candidates', () => {
  const docs = splitDocs('- 2026-01-01 old note about deploy\n- 2026-10-20 deploy broke the proxy\n', 'stream')
  const plain = search(docs, 'deploy', { topK: 2 })
  const reranked = search(docs, 'deploy', { topK: 2, timeDecay: true, halfLifeDays: 30, now: '2026-10-22T00:00:00Z' })
  assert.equal(plain.applied, false)
  assert.equal(reranked.applied, true)
  assert.match(reranked.hits[0].text, /2026-10-20/)
})

test('clipBytes never exceeds the byte budget or splits an emoji', () => {
  const text = '记忆😀'.repeat(50)
  const out = clipBytes(text, 40)
  assert.ok(bytes(out.text) <= 40)
  assert.equal(out.clipped, true)
  assert.ok(!out.text.includes('\uFFFD'))
})

test('escapeBraces breaks template openings only', () => {
  assert.equal(escapeBraces('plain text'), 'plain text')
  assert.ok(!escapeBraces('{{char}}').includes('{{'))
})

test('sanitize redacts credential-shaped strings', () => {
  const out = sanitize('key sk-abcdefghijklmnopqrstuvwx and 1234567890123456')
  assert.ok(!out.includes('sk-abcdefghijklmnopqrstuvwx'))
  assert.ok(!out.includes('1234567890123456'))
})

test('formatTurn drops turns without both sides and stays one line', () => {
  assert.equal(formatTurn({ user: 'hi' }), null)
  assert.equal(formatTurn({ user: 'hi', assistant: '  ' }), null)
  const line = formatTurn({ user: 'a\nb', assistant: 'c\nd', at: new Date(2026, 9, 22, 22, 48) })
  assert.equal(line, '- 2026-10-22 22:48 | 用户：a b | 助手：c d')
})

test('appendTurn writes once and rejects an identical repeat', () => {
  const home = tempHome()
  ensureLayout(home)
  const turn = { user: 'q', assistant: 'a', at: new Date(2026, 9, 22, 22, 48) }
  assert.equal(appendTurn(home, turn).written, true)
  assert.equal(appendTurn(home, turn).reason, 'duplicate')
  const stream = readFileSync(join(home, 'stream.md'), 'utf8')
  assert.equal(stream.trim().split('\n').filter(Boolean).length, 2) // header + one turn
})

test('appendLayer leaves a missing trailing newline intact', () => {
  const home = tempHome()
  ensureLayout(home)
  writeFileSync(join(home, 'stream.md'), 'no newline at end', 'utf8')
  appendLayer(home, 'stream.md', 'next line')
  assert.equal(readFileSync(join(home, 'stream.md'), 'utf8'), 'no newline at end\nnext line\n')
})

test('buildCore clips to the configured budget and reports it', () => {
  const home = tempHome()
  ensureLayout(home)
  writeFileSync(join(home, 'core.md'), `# Core\n${'x'.repeat(4000)}\n`, 'utf8')
  const out = buildCore(home, { coreLimitKB: 1 })
  assert.equal(out.clipped, true)
  assert.ok(bytes(out.text) <= 1024)
})

test('fitHits honors the prompt budget and keeps at least one hit', () => {
  const hits = [{ source: 'core', line: 1, text: 'x'.repeat(3000) }, { source: 'core', line: 2, text: 'y' }]
  assert.equal(fitHits(hits, 1024).length, 1)
})

test('plugin injects two sections, recalls on user input, and records the turn', () => {
  const home = tempHome()
  ensureLayout(home)
  writeFileSync(join(home, 'core.md'), '# Core\n\n- prefers terse answers\n', 'utf8')
  writeFileSync(join(home, 'ws', 'clock.md'), '## Clock\n\n2026-10-22 dual boot RTC offset was eight hours.\n', 'utf8')

  const sections = []
  const handlers = new Map()
  const ctx = {
    on: (event, handler) => handlers.set(event, handler),
    systemPrompt: { section: spec => sections.push(spec) },
  }
  apply(ctx, { home, topK: 3 })

  assert.deepEqual(sections.map(s => s.name), ['memory-dba:core', 'memory-dba:hits'])
  assert.match(sections[0].text(), /terse/)

  handlers.get('session/event')(
    { id: 's1' },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'RTC clock offset' }] } },
  )
  assert.match(sections[1].text(), /eight hours/)

  handlers.get('session/event')(
    { id: 's1' },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'fixed with RealTimeIsUniversal' }] } } },
  )
  handlers.get('session/event')({ id: 's1' }, { type: 'turn/end' })
  assert.match(readFileSync(join(home, 'stream.md'), 'utf8'), /RealTimeIsUniversal/)
})

test('plugin initializes a missing memory directory instead of failing', () => {
  const home = join(tempHome(), 'nested', 'memory')
  const sections = []
  const ctx = { on: () => {}, systemPrompt: { section: spec => sections.push(spec) } }
  assert.doesNotThrow(() => apply(ctx, { home }))
  assert.ok(readFileSync(join(home, 'core.md'), 'utf8').startsWith('# Core memory'))
  assert.match(sections[0].text(), /# Core memory/)
})
