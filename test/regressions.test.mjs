import assert from 'node:assert/strict'
import fs, { mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { after, mock, test } from 'node:test'
import { buildCore, buildHits } from '../src/assemble.mjs'
import { apply } from '../src/index.mjs'
import { loadCorpus, search, splitDocs, STREAM_MAX_BYTES, STREAM_MAX_DOCS, wsTitle } from '../src/search.mjs'
import { bytes, clipBytes, ensureLayout, fingerprint, readLayer } from '../src/store.mjs'
import { docKey, semanticRecall } from '../src/vector.mjs'
import { formatTurn, oneLine, sanitize } from '../src/stream.mjs'

const homes = []
function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'dba-regression-'))
  homes.push(home)
  return home
}
after(() => homes.forEach(home => rmSync(home, { recursive: true, force: true })))

function plugin(home, config = {}, runtime = {}) {
  const sections = []
  const contexts = []
  const handlers = new Map()
  apply({
    on: (name, handler) => handlers.set(name, handler),
    systemPrompt: {
      section: section => sections.push(section),
      context: spec => contexts.push(spec),
    },
  }, { home, ...config }, runtime)
  return {
    sections,
    contexts,
    event: (id, event) => handlers.get('session/event')({ id }, event),
    user: (id, text) => handlers.get('session/event')({ id }, {
      type: 'user/message', data: { source: { kind: 'user' }, content: text },
    }),
    hits: () => contexts[0].text(),
    hitsFor: id => contexts[0].text({ agent: { id } }),
    dispose: id => handlers.get('session/disposed')({ id }),
  }
}

test('retrieval hits never reach the system prompt', () => {
  // A hit list inside the system prompt changes the head of every request and
  // invalidates the whole conversation behind it; it belongs in runtime context.
  const home = tempHome()
  ensureLayout(home)
  writeFileSync(join(home, 'stream.md'), '- 2026-11-03 needle stays out of the head\n')
  const runtime = plugin(home)
  runtime.user('one', 'needle')
  assert.deepEqual(runtime.sections.map(section => section.name), ['memory-dba:core'])
  assert.deepEqual(runtime.contexts.map(context => context.name), ['memory-dba:hits'])
  assert.match(runtime.hits(), /stays out of the head/)
})

test('workspace edits, additions, removals and renames invalidate cached retrieval', () => {
  const home = tempHome()
  ensureLayout(home)
  const file = join(home, 'ws', 'note.md')
  const body = 'body sentences must never be recalled at level one'
  // Only the first line is indexed, so the title carries the query term and the
  // body is a unique canary: if a body ever leaks, the assertions below fail.
  writeFileSync(file, `# 工作区 · needlealpha\n${body}\n`)
  // This test is about corpus invalidation, not the empty-recall hint.
  const runtime = plugin(home, { coldHint: 'off' })
  runtime.user('one', 'needlealpha')
  assert.match(runtime.hits(), /ws\/note\.md/)
  assert.doesNotMatch(runtime.hits(), /body sentences must never/)
  let previous = fingerprint(home)
  writeFileSync(file, `# 工作区 · needlebeta\n${body}\n`)
  utimesSync(file, new Date(), new Date(Date.now() + 2000))
  assert.notEqual(fingerprint(home), previous)
  runtime.user('one', 'needlebeta')
  assert.match(runtime.hits(), /ws\/note\.md/)
  assert.doesNotMatch(runtime.hits(), /body sentences must never/)
  // The old title no longer exists in the corpus: the cache did reload.
  runtime.user('one', 'needlealpha')
  assert.doesNotMatch(runtime.hits(), /ws\/note\.md/)
  previous = fingerprint(home)
  renameSync(file, join(home, 'ws', 'renamed.md'))
  assert.notEqual(fingerprint(home), previous)
  runtime.user('one', 'needlebeta')
  assert.match(runtime.hits(), /ws\/renamed\.md/)
  previous = fingerprint(home)
  writeFileSync(join(home, 'ws', 'extra.md'), `# 工作区 · uniquegamma\n${body}\n`)
  assert.notEqual(fingerprint(home), previous)
  runtime.user('one', 'uniquegamma')
  assert.match(runtime.hits(), /ws\/extra\.md/)
  rmSync(join(home, 'ws', 'extra.md'))
  runtime.user('one', 'uniquegamma')
  assert.equal(runtime.hits(), '')
})

test('prompt hits follow the most recent user turn', () => {
  const home = tempHome()
  ensureLayout(home)
  writeFileSync(join(home, 'stream.md'), 'alpha private apples\nbeta private bananas\n')
  const runtime = plugin(home)
  runtime.user('one', 'alpha')
  assert.match(runtime.hits(), /apples/)
  assert.doesNotMatch(runtime.hits(), /bananas/)
  runtime.user('two', 'beta')
  assert.match(runtime.hits(), /bananas/)
  assert.doesNotMatch(runtime.hits(), /apples/)
  // Disposal clears that session's slot; a context without an agent id still
  // sees the latest single slot (the compatibility fallback).
  runtime.dispose('two')
  assert.equal(runtime.hitsFor('two'), '')
  assert.match(runtime.hits(), /bananas/)
})

test('workspace hint derives its script path from home and honors the config override', () => {
  const home = tempHome()
  ensureLayout(home)
  writeFileSync(join(home, 'ws', '记忆系统.md'), '# 工作区 · 记忆系统\n')

  const derived = plugin(home)
  derived.user('one', '记忆系统')
  const expected = join(home, '..', 'scripts', 'nb_search.py')
  assert.ok(derived.hits().includes(expected))
  assert.match(derived.hits(), /py -3\.14/)
  assert.match(derived.hits(), /--file <区名>/)

  // A configured value replaces the whole line: non-Windows installs and other
  // launchers must not inherit the derived Windows-looking command.
  const custom = 'CUSTOM HINT: my-nb-search --file <区名>'
  const overridden = plugin(home, { detailHint: custom })
  overridden.user('one', '记忆系统')
  assert.match(overridden.hits(), /CUSTOM HINT: my-nb-search/)
  assert.ok(!overridden.hits().includes(expected))
})

test('workspace recall is name-only and points at the --file second pass', () => {
  const home = tempHome()
  ensureLayout(home)
  const body = '缓存命中率跌到 51% 的直接原因是召回块插在 system prompt 中段。'
  writeFileSync(join(home, 'ws', '记忆系统.md'),
    `# 工作区 · 记忆系统\n_详载本区工作内容 | 云端模型维护_\n\n## 2026-11-03 缓存命中率\n${body}\n`)

  const docs = loadCorpus(home)
  const workspace = docs.filter(doc => doc.source === 'ws/记忆系统.md')
  assert.equal(workspace.length, 1)
  assert.equal(workspace[0].text, 'ws/记忆系统.md\n# 工作区 · 记忆系统')
  assert.equal(workspace[0].date, null)

  // Level 1 can match the area name...
  const runtime = plugin(home)
  runtime.user('one', '记忆系统')
  const hits = runtime.hits()
  assert.match(hits, /- \[ws\/记忆系统\.md\]/)
  assert.match(hits, /详情用/)
  assert.match(hits, /--file/)
  assert.match(hits, /nb_search\.py/)
  // ...but the body is not in the prompt and not even in the level-1 corpus.
  assert.doesNotMatch(hits, /缓存命中率跌到 51%/)
  const bodyOnly = search(docs, '缓存命中率')
  assert.ok(!bodyOnly.hits.some(hit => hit.source === 'ws/记忆系统.md'))
  const hit = search(docs, '记忆系统').hits.find(entry => entry.source === 'ws/记忆系统.md')
  // The plugin keeps the name-only text on the hit object (it is the BM25
  // document), but `buildHits` must never print it — the assertion above pins
  // that. What matters here is that it is exactly file name + first-line title.
  assert.equal(hit.text, 'ws/记忆系统.md\n# 工作区 · 记忆系统')
})

test('core is injected in full but never enters the recall corpus', () => {
  const home = tempHome()
  ensureLayout(home)
  const canary = 'CORECANARY_9431'
  writeFileSync(join(home, 'core.md'), `# Core\n\n- ${canary} 只在核心记忆里\n`)
  writeFileSync(join(home, 'stream.md'), '- 2026-11-03 stream unrelated\n')

  // The corpus keeps stream and workspace names only: core is injection-only.
  const docs = loadCorpus(home)
  assert.ok(!docs.some(doc => doc.source === 'core'))
  // buildCore is untouched: the whole core layer still reaches the system prompt.
  const core = buildCore(home, { coreLimitKB: 15 })
  assert.ok(core.text.length > 0)
  assert.match(core.text, new RegExp(canary))
  // A core-only term cannot be recalled, so the hits block never repeats core.
  assert.equal(buildHits(search(docs, canary).hits, { budgetKB: 6, coldHint: 'off' }).text, '')
  // The semantic channel derives its keys from the same corpus; a missing core
  // key set is not an error and simply has nothing to score there.
  assert.doesNotThrow(() => semanticRecall(home, canary, docs.map(doc => docKey(doc.text)), { timeoutMs: 1 }))

  const runtime = plugin(home)
  assert.match(runtime.sections[0].text(), new RegExp(canary))
  runtime.user('one', canary)
  assert.doesNotMatch(runtime.hits(), new RegExp(canary))
})

test('core is snapshotted per session and refreshed for new or disposed sessions', () => {
  const home = tempHome()
  ensureLayout(home)
  writeFileSync(join(home, 'core.md'), '# Core\n\n- first core\n')
  const runtime = plugin(home)
  const first = runtime.sections[0].text({ agent: { id: 'session-A' } })
  assert.match(first, /first core/)
  writeFileSync(join(home, 'core.md'), '# Core\n\n- second core\n')
  // Same session keeps its snapshot even though the file changed.
  assert.equal(runtime.sections[0].text({ agent: { id: 'session-A' } }), first)
  // A new session reads the current file.
  assert.match(runtime.sections[0].text({ agent: { id: 'session-B' } }), /second core/)
  // Without an id there is no safe key: reread every assembly.
  assert.match(runtime.sections[0].text(), /second core/)
  runtime.dispose('session-A')
  assert.match(runtime.sections[0].text({ agent: { id: 'session-A' } }), /second core/)
  // A broken core only affects sessions that have to read it; live snapshots stay.
  writeFileSync(join(home, 'core.md'), Buffer.from([0xff]))
  assert.equal(runtime.sections[0].text({ agent: { id: 'session-C' } }), '')
  assert.match(runtime.sections[0].text({ agent: { id: 'session-B' } }), /second core/)
})

test('core snapshots read once per session, no-id fallback rereads, and coreRefresh always rereads', () => {
  const home = tempHome()
  ensureLayout(home)
  let reads = 0
  const build = () => ({ text: `core-${++reads}`, clipped: false, missing: false })
  const runtime = plugin(home, {}, { buildCore: build })
  assert.equal(runtime.sections[0].text({ agent: { id: 'A' } }), 'core-1')
  assert.equal(runtime.sections[0].text({ agent: { id: 'A' } }), 'core-1')
  assert.equal(reads, 1)
  assert.equal(runtime.sections[0].text({ agent: { id: 'B' } }), 'core-2')
  // No id: the fallback reads every time and only keeps a single last-read slot.
  assert.equal(runtime.sections[0].text(), 'core-3')
  assert.equal(runtime.sections[0].text(), 'core-4')
  assert.equal(reads, 4)
  const always = plugin(home, { coreRefresh: 'always' }, { buildCore: build })
  assert.equal(always.sections[0].text({ agent: { id: 'A' } }), 'core-5')
  assert.equal(always.sections[0].text({ agent: { id: 'A' } }), 'core-6')
  assert.equal(reads, 6)
})

test('core snapshot survives 40 sessions; disposal releases it and always refreshes', () => {
  const home = tempHome()
  ensureLayout(home)
  writeFileSync(join(home, 'core.md'), '# Core\n\n- core before change\n')
  const runtime = plugin(home)
  for (let i = 0; i < 40; i += 1) {
    assert.match(runtime.sections[0].text({ agent: { id: `session-${i}` } }), /core before change/)
  }

  writeFileSync(join(home, 'core.md'), '# Core\n\n- core after change\n')
  // Even after more than 32 sessions, every still-live session keeps its head.
  assert.match(runtime.sections[0].text({ agent: { id: 'session-0' } }), /core before change/)
  assert.match(runtime.sections[0].text({ agent: { id: 'session-39' } }), /core before change/)
  assert.match(runtime.sections[0].text({ agent: { id: 'session-new' } }), /core after change/)

  // Disposed sessions release their snapshot and read the current core if reused.
  runtime.dispose('session-0')
  assert.match(runtime.sections[0].text({ agent: { id: 'session-0' } }), /core after change/)

  const always = plugin(home, { coreRefresh: 'always' })
  assert.match(always.sections[0].text({ agent: { id: 'session-always' } }), /core after change/)
  writeFileSync(join(home, 'core.md'), '# Core\n\n- core changed again\n')
  assert.match(always.sections[0].text({ agent: { id: 'session-always' } }), /core changed again/)
})

test('core snapshots store the clipped section, so coreLimitKB applies once per session', () => {
  const home = tempHome()
  ensureLayout(home)
  writeFileSync(join(home, 'core.md'), 'x'.repeat(4000))
  const runtime = plugin(home, { coreLimitKB: 1 })
  const first = runtime.sections[0].text({ agent: { id: 'A' } })
  assert.ok(bytes(first) <= 1024)
  writeFileSync(join(home, 'core.md'), 'y'.repeat(3000))
  assert.equal(runtime.sections[0].text({ agent: { id: 'A' } }), first)
  const second = runtime.sections[0].text({ agent: { id: 'B' } })
  assert.ok(bytes(second) <= 1024)
  assert.notEqual(second, first)
})

test('retrieval hits are isolated per session and cleared on disposal', () => {
  const home = tempHome()
  ensureLayout(home)
  writeFileSync(join(home, 'stream.md'), '- 2026-11-03 alpha private apples\n- 2026-11-03 beta private bananas\n')
  const runtime = plugin(home)
  runtime.user('A', 'alpha')
  runtime.user('B', 'beta')
  assert.match(runtime.hitsFor('A'), /apples/)
  assert.doesNotMatch(runtime.hitsFor('A'), /bananas/)
  assert.match(runtime.hitsFor('B'), /bananas/)
  assert.doesNotMatch(runtime.hitsFor('B'), /apples/)
  // No agent id still falls back to the latest single slot.
  assert.match(runtime.hits(), /bananas/)
  runtime.dispose('A')
  assert.equal(runtime.hitsFor('A'), '')
  assert.match(runtime.hitsFor('B'), /bananas/)
})

test('empty recall adds a cold-path hint that can be overridden or disabled', () => {
  const home = tempHome()
  ensureLayout(home)
  const runtime = plugin(home)
  runtime.user('A', 'no-such-word-here')
  const cold = runtime.hitsFor('A')
  assert.match(cold, /本地召回本轮无命中/)
  assert.match(cold, /全量历史/)
  assert.match(cold, /nb_search\.py/)
  assert.match(cold, /--file/)
  // A non-empty hit list must not carry the cold line.
  writeFileSync(join(home, 'stream.md'), '- 2026-11-03 alpha private apples\n')
  runtime.user('A', 'alpha')
  assert.match(runtime.hitsFor('A'), /apples/)
  assert.doesNotMatch(runtime.hitsFor('A'), /本地召回本轮无命中/)

  const custom = plugin(home, { coldHint: 'CUSTOM COLD HINT' })
  custom.user('A', 'no-such-word-here')
  assert.equal(custom.hitsFor('A'), 'CUSTOM COLD HINT')
  const off = plugin(home, { coldHint: 'off' })
  off.user('A', 'no-such-word-here')
  assert.equal(off.hitsFor('A'), '')
  const explicitEmpty = plugin(home, { coldHint: '' })
  explicitEmpty.user('A', 'no-such-word-here')
  assert.equal(explicitEmpty.hitsFor('A'), '')
  assert.match(buildHits([], { budgetKB: 6 }).text, /nb_search\.py/)
  assert.equal(buildHits([], { budgetKB: 6, coldHint: 'off' }).text, '')
})

test('level-one workspace titles come only from a real first-line heading', () => {
  assert.equal(wsTitle('# 工作区 · x\nbody'), '# 工作区 · x')
  assert.equal(wsTitle('## Section\nbody'), '')
  assert.equal(wsTitle('body\n# not a title'), '')
  assert.equal(wsTitle('\uFEFF# 工作区 · bom\nbody'), '# 工作区 · bom')
})

test('semantic workspace hits stay name-only', () => {
  const home = tempHome()
  ensureLayout(home)
  const body = '这段正文绝不能出现在提示词里'
  writeFileSync(join(home, 'ws', 'area.md'), `# 工作区 · area\n\n## note\n${body}\n`)
  const docs = loadCorpus(home)
  const workspace = docs.find(doc => doc.source === 'ws/area.md')
  const semantic = new Map([[docKey(workspace.text), 0.99]])
  const result = search(docs, 'unrelatedquery', { topK: 5, semantic })
  assert.ok(result.hits.some(hit => hit.source === 'ws/area.md' && hit.semantic))
  const rendered = buildHits(result.hits, { budgetKB: 6 }).text
  assert.match(rendered, /- \[ws\/area\.md\] \(semantic\)/)
  assert.doesNotMatch(rendered, /绝不能出现/)
})

test('buildHits never renders a workspace body even if a hit carries one', () => {
  // Defense in depth: an old corpus, a hand-built hit, or a future caller can
  // still hand `buildHits` a workspace hit whose text contains a body. The
  // renderer must stay name-only, otherwise the level-1 boundary depends on
  // every producer behaving.
  const rendered = buildHits([
    { source: 'ws/记忆系统.md', line: 1, text: '# 工作区 · 记忆系统\nSECRET BODY SENTENCE' },
  ], { budgetKB: 6 }).text
  assert.match(rendered, /- \[ws\/记忆系统\.md\]/)
  assert.doesNotMatch(rendered, /SECRET BODY SENTENCE/)
  assert.match(rendered, /--file/)
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

test('core fallback without a session id rereads on every assembly', () => {
  // Diagnostics/tests/non-agent assemblies have no id to key a snapshot safely;
  // this is the documented degradation, not the default session behavior.
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
  writeFileSync(join(home, 'ws', 'valid.md'), '# 工作区 · valid searchable memory\n\nbody\n')
  const docs = loadCorpus(home)
  assert.equal(docs.length, 1)
  assert.equal(docs[0].source, 'ws/valid.md')
  assert.throws(() => loadCorpus(home, { strict: true }), /encoded data/)
  const runtime = plugin(home)
  assert.equal(runtime.sections[0].text(), '')
  runtime.user('one', 'valid')
  assert.match(runtime.hits('one'), /ws\/valid\.md/)
})

test('an unreadable home degrades safely and clears previously recalled hits', () => {
  const home = tempHome()
  ensureLayout(home)
  writeFileSync(join(home, 'ws', 'valid.md'), '# 工作区 · needle memory\n\nbody\n')
  // This test is about degradation, not the empty-recall hint.
  const runtime = plugin(home, { coldHint: 'off' })
  runtime.user('one', 'needle')
  assert.match(runtime.hits('one'), /ws\/valid\.md/)
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
  writeFileSync(join(home, 'ws', 'valid.md'), '# 工作区 · needle memory\n\nbody\n')
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
    assert.match(runtime.hits('one'), /ws\/valid\.md/)
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
  // core is injection-only and not part of the recall corpus, so a broken core
  // must fail the core check without being reported as a broken corpus.
  assert.match(corrupt.text, /ok\s+corpus/)
  writeFileSync(join(home, 'ws', 'broken.md'), Buffer.from([0xff]))
  const brokenCorpus = await cli(['doctor', '--home', home])
  assert.notEqual(brokenCorpus.code, 0)
  assert.match(brokenCorpus.text, /FAIL corpus/)
  assert.doesNotMatch(brokenCorpus.text, /\n\s+at /)
  assert.doesNotMatch(corrupt.text, /\n\s+at /)
  const blocked = join(tempHome(), 'not-a-directory')
  writeFileSync(blocked, 'file')
  const broken = await cli(['doctor', '--home', blocked, '--json'])
  assert.notEqual(broken.code, 0)
  const report = JSON.parse(broken.text)
  assert.equal(report.ok, false)
  assert.ok(report.checks.some(check => check.name === 'layout' && !check.ok))
})
