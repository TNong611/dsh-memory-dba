import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { after, mock, test } from 'node:test'
import { embed, EmbedUnavailable } from '../src/embed.mjs'
import { normalizeConfig, recall, apply } from '../src/index.mjs'
import { search, splitDocs } from '../src/search.mjs'
import { ensureLayout } from '../src/store.mjs'
import { cosineInt8, decodeVector, docKey, encodeVector, loadVectorCache, MissingVectors, saveVectorCache, semanticRecall, VectorCorrupt } from '../src/vector.mjs'

const testRoot = fileURLToPath(new URL('./', import.meta.url))
const homes = []
function tempHome() {
  const home = mkdtempSync(join(testRoot, '.vector-test-'))
  homes.push(home)
  return home
}
after(() => {
  for (const home of homes) {
    assert.ok(home.startsWith(join(testRoot, '.vector-test-')))
    rmSync(home, { recursive: true, force: true })
  }
})

const fixed = Float32Array.from([1, 0.5, -0.25, 0, 0, 0, 0, 0])
function cacheFor(texts) {
  return { version: 1, model: 'bge-m3', dim: 8, entries: Object.fromEntries(texts.map(text => [docKey(text), encodeVector(fixed)])) }
}

test('int8 quantization stays within half a scale and preserves cosine ordering', () => {
  const vector = Float32Array.from([0.07, -0.91, 0.36, 0, 1.3, -2.7, 0.88, -0.04])
  const entry = encodeVector(vector)
  const decoded = decodeVector(entry)
  vector.forEach((value, index) => assert.ok(Math.abs(value - decoded[index]) <= entry.s / 2 + 1e-6))
  const aligned = encodeVector(Float32Array.from([1, 0]))
  const nearby = encodeVector(Float32Array.from([1, 0.5]))
  const orthogonal = encodeVector(Float32Array.from([0, 1]))
  const opposed = encodeVector(Float32Array.from([-1, 0]))
  assert.ok(cosineInt8(aligned, aligned) > cosineInt8(aligned, nearby))
  assert.ok(cosineInt8(aligned, nearby) > cosineInt8(aligned, orthogonal))
  assert.ok(cosineInt8(aligned, orthogonal) > cosineInt8(aligned, opposed))
  assert.equal(cosineInt8(encodeVector(new Float32Array(2)), aligned), 0)
  assert.throws(() => encodeVector(Float32Array.of(NaN)), VectorCorrupt)
})

test('vector cache roundtrips portable text keys and distinguishes missing and corrupt files', () => {
  const home = tempHome()
  assert.throws(() => loadVectorCache(home), MissingVectors)
  assert.equal(docKey('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d')
  const cache = cacheFor(['alpha'])
  saveVectorCache(home, cache)
  assert.deepEqual(loadVectorCache(home), cache)
  const file = join(home, '.vec', 'embeddings.json')
  assert.ok(!readFileSync(file, 'utf8').includes(home))
  for (const invalid of ['{', 'null', '{}', JSON.stringify({ ...cache, dim: 9 }), JSON.stringify({ ...cache, entries: { bad: encodeVector(fixed) } }), JSON.stringify({ ...cache, entries: { [docKey('alpha')]: { s: 1, q: '!!!' } } })]) {
    writeFileSync(file, invalid)
    assert.throws(() => loadVectorCache(home), VectorCorrupt)
  }
})

test('embed supports modern and 404 legacy APIs and wraps all unavailable responses', async context => {
  const requests = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ path: request.url, body: JSON.parse(body) })
    response.setHeader('content-type', 'application/json')
    if (request.url === '/legacy/api/embed') {
      response.writeHead(404).end('{}')
    } else if (request.url === '/legacy/api/embeddings') {
      response.end(JSON.stringify({ embedding: [...fixed] }))
    } else if (request.url.startsWith('/down/')) {
      response.writeHead(503).end('{}')
    } else if (request.url.startsWith('/missing/')) {
      response.writeHead(404).end('{}')
    } else if (request.url.startsWith('/bad/')) {
      response.end('{"embeddings":[["invalid"]]}')
    } else {
      response.end(JSON.stringify({ embeddings: [[...fixed]] }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => { server.closeAllConnections(); server.close() })
  const url = `http://127.0.0.1:${server.address().port}`
  assert.deepEqual(await embed('hello', { url, model: 'fake', timeoutMs: 1000 }), fixed)
  assert.deepEqual(requests[0], { path: '/api/embed', body: { model: 'fake', input: 'hello', keep_alive: '30m' } })
  assert.deepEqual(await embed('legacy', { url: `${url}/legacy`, model: 'fake', timeoutMs: 1000 }), fixed)
  assert.deepEqual(requests.slice(1), [
    { path: '/legacy/api/embed', body: { model: 'fake', input: 'legacy', keep_alive: '30m' } },
    { path: '/legacy/api/embeddings', body: { model: 'fake', prompt: 'legacy', keep_alive: '30m' } },
  ])
  await assert.rejects(embed('down', { url: `${url}/down` }), EmbedUnavailable)
  await assert.rejects(embed('missing', { url: `${url}/missing` }), EmbedUnavailable)
  await assert.rejects(embed('bad', { url: `${url}/bad` }), EmbedUnavailable)
  await assert.rejects(embed('bad-url', { url: 'not a URL' }), EmbedUnavailable)
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await assert.rejects(embed('closed', { url }), EmbedUnavailable)
})

test('semantic hits append after keyword hits and honor the cosine floor', () => {
  const docs = splitDocs('needle needle\nneedle extra words here\nunrelated concept\n', 'core')
  const plain = search(docs, 'needle', { topK: 3 })
  assert.deepEqual(plain.hits.map(hit => hit.line), [1, 2])
  const semantic = new Map([[docKey(docs[1].text), 0.99], [docKey(docs[2].text), 0.9]])
  const hybrid = search(docs, 'needle', { topK: 3, semantic })
  assert.deepEqual(hybrid.hits.map(hit => hit.line), [1, 2, 3])
  assert.equal(hybrid.hits[0].score, plain.hits[0].score)
  assert.equal(hybrid.hits[2].semantic, true)
  assert.deepEqual(search(docs, 'needle', { topK: 3, semantic }), hybrid)
  assert.deepEqual(search(docs, 'needle', { topK: 3, semantic, semanticMinScore: 0.95 }).hits.map(hit => hit.line), [1, 2])
  assert.deepEqual(search(docs, 'absent', { semantic }).hits.map(hit => hit.line), [2, 3])
  const tied = new Map(docs.map(doc => [docKey(doc.text), 1]))
  assert.deepEqual(search(docs, '', { semantic: tied }).hits.map(hit => hit.line), [1, 2, 3])
})

test('recall never relaxes shared-term hits and retries CJK unigrams just once', () => {
  const docs = splitDocs('苹果 exact\n苹 distant 果\n', 'core')
  const exact = search(docs, '苹果', { topK: 5 })
  const recalled = recall(docs, '苹果', { topK: 5 })
  assert.equal(recalled.relaxed, false)
  assert.deepEqual(recalled.hits, exact.hits)
  assert.deepEqual(recalled.hits.map(hit => hit.line), [1])
  const weak = splitDocs('苹 distant 果\n', 'core')
  assert.equal(search(weak, '苹果').hits.length, 0)
  assert.equal(recall(weak, '苹果').relaxed, true)
  assert.equal(recall(weak, '苹果').hits[0].text, weak[0].text)
  assert.equal(recall(weak, 'unmatched').relaxed, false)
  const semantic = new Map([[docKey(weak[0].text), 0.9]])
  const widened = recall(weak, '苹果', { semantic })
  assert.equal(widened.relaxed, false)
  assert.equal(widened.hits[0].semantic, true)
})

test('vector configuration merges partial objects and rejects invalid values', () => {
  const baseline = normalizeConfig().vector
  assert.deepEqual(baseline, { enabled: true, url: 'http://127.0.0.1:11434', model: 'bge-m3', timeoutMs: 1500, minScore: 0.45, keepAlive: '30m' })
  assert.deepEqual(normalizeConfig({ vector: { enabled: false } }).vector, { ...baseline, enabled: false })
  assert.deepEqual(normalizeConfig({ vector: { url: null, model: '', timeoutMs: 'bad', minScore: 2, keepAlive: '' } }).vector, baseline)
  assert.deepEqual(normalizeConfig({ vector: null }).vector, baseline)
  assert.deepEqual(normalizeConfig({ vector: { url: 'http://', timeoutMs: 0, weight: -1 } }).vector, baseline)
})

test('worker bridge returns key-aligned scores and bounds server-down and timeout paths', async context => {
  const server = new Worker(new URL('./fixtures/embed-server.mjs', import.meta.url))
  context.after(() => server.terminate())
  const [url] = await once(server, 'message')
  const home = tempHome()
  const cache = cacheFor(['first', 'second'])
  cache.entries[docKey('second')] = encodeVector(Float32Array.from([-1, -0.5, 0.25, 0, 0, 0, 0, 0]))
  saveVectorCache(home, cache)
  const keys = [docKey('second'), docKey('uncached'), docKey('first')]
  const started = performance.now()
  const result = semanticRecall(home, 'query', keys, { url, topK: 8 })
  const successMs = performance.now() - started
  assert.ok(result instanceof Map)
  assert.deepEqual([...result.keys()], [docKey('first'), docKey('second')])
  assert.ok(result.get(docKey('first')) > 0.99)
  assert.ok(successMs < 3000, `success took ${successMs}ms`)
  const slowStart = performance.now()
  assert.equal(semanticRecall(home, 'slow', keys, { url: `${url}/slow`, timeoutMs: 100 }), null)
  const timeoutMs = performance.now() - slowStart
  assert.ok(timeoutMs < 400, `timeout took ${timeoutMs}ms`)
  const recovery = semanticRecall(home, 'fresh', keys, { url, timeoutMs: 1200 })
  assert.ok(recovery instanceof Map)
  const defaultStart = performance.now()
  assert.equal(semanticRecall(home, 'slow default', keys, { url: `${url}/slow` }), null)
  const defaultMs = performance.now() - defaultStart
  assert.ok(defaultMs < 3000, `default timeout took ${defaultMs}ms`)
  const crowded = tempHome()
  const texts = Array.from({ length: 10 }, (_, index) => `document ${index}`)
  saveVectorCache(crowded, cacheFor(texts))
  assert.deepEqual([...semanticRecall(crowded, 'capped', texts.map(docKey), { url, topK: 50 }).keys()], texts.slice(0, 8).map(docKey))
  assert.equal(semanticRecall(home, 'mismatch', keys, { url, model: 'wrong', timeoutMs: 400 }), null)
  await server.terminate()
  const downStart = performance.now()
  assert.equal(semanticRecall(home, 'down', keys, { url, timeoutMs: 400 }), null)
  const downMs = performance.now() - downStart
  assert.ok(downMs < 900, `server-down took ${downMs}ms`)
  const repeatStart = performance.now()
  assert.equal(semanticRecall(home, 'down again', keys, { url, timeoutMs: 1500 }), null)
  const repeatMs = performance.now() - repeatStart
  assert.ok(repeatMs < 50, `cooldown repeat took ${repeatMs}ms`)
  context.diagnostic(`worker success ${successMs.toFixed(1)}ms; 100ms timeout ${timeoutMs.toFixed(1)}ms; default timeout ${defaultMs.toFixed(1)}ms; server-down ${downMs.toFixed(1)}ms; cooldown repeat ${repeatMs.toFixed(1)}ms`)
})

test('plugin synchronous prompt injection includes semantic-only matches', async context => {
  const server = new Worker(new URL('./fixtures/embed-server.mjs', import.meta.url))
  context.after(() => server.terminate())
  const [url] = await once(server, 'message')
  const home = tempHome()
  ensureLayout(home)
  writeFileSync(join(home, 'core.md'), 'semantic memory only\n')
  saveVectorCache(home, cacheFor(['semantic memory only']))
  const sections = []
  const handlers = new Map()
  apply({ on: (name, handler) => handlers.set(name, handler), systemPrompt: { section: section => sections.push(section) } }, { home, vector: { url, timeoutMs: 1000 } })
  const returned = handlers.get('session/event')({ id: 's' }, { type: 'user/message', data: { source: { kind: 'user' }, content: 'unrelatedquery' } })
  assert.equal(returned, undefined)
  assert.equal(typeof sections[1].text(), 'string')
  assert.match(sections[1].text(), /semantic memory only/)
})

let cliRun = 0
async function cli(args) {
  const argv = process.argv
  const exitCode = process.exitCode
  const output = []
  const log = mock.method(console, 'log', (...parts) => output.push(parts.join(' ')))
  const error = mock.method(console, 'error', (...parts) => output.push(parts.join(' ')))
  try {
    process.argv = [argv[0], 'cli.mjs', ...args]
    process.exitCode = 0
    await import(`../bin/cli.mjs?vectorRun=${cliRun += 1}`)
    return { code: process.exitCode, text: output.join('\n') }
  } finally {
    process.argv = argv
    process.exitCode = exitCode
    log.mock.restore()
    error.mock.restore()
  }
}

test('CLI index uses four requests, preserves caches on failure, and diagnoses optional vectors', async context => {
  let active = 0
  let peak = 0
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk
    active += 1
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 15))
    response.end(JSON.stringify({ embeddings: [[...fixed]] }))
    active -= 1
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => { server.closeAllConnections(); server.close() })
  const url = `http://127.0.0.1:${server.address().port}`
  const home = tempHome()
  ensureLayout(home)
  writeFileSync(join(home, 'core.md'), 'one\ntwo\nthree\nfour\nfive\none\n')
  writeFileSync(join(home, 'stream.md'), '')
  const indexed = await cli(['index', '--home', home, '--url', url])
  assert.equal(indexed.code, 0)
  assert.match(indexed.text, /indexed 5 docs in \d+ms \(1 skipped\)/)
  assert.equal(peak, 4)
  const file = join(home, '.vec', 'embeddings.json')
  const saved = readFileSync(file, 'utf8')
  assert.equal(loadVectorCache(home).dim, 8)
  assert.match((await cli(['stats', '--home', home])).text, /vector cache\s+\d+ B/)
  const healthy = await cli(['doctor', '--home', home, '--url', url])
  assert.equal(healthy.code, 0)
  assert.match(healthy.text, /5\/6 entries\/documents; 6\/6 covered/)
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  const failed = await cli(['index', '--home', home, '--url', url])
  assert.equal(failed.code, 2)
  assert.match(failed.text, /embedder/)
  assert.equal(readFileSync(file, 'utf8'), saved)
  const fresh = await cli(['doctor', '--home', tempHome(), '--url', url])
  assert.equal(fresh.code, 0)
  assert.match(fresh.text, /optional.*embedder unavailable/)
  writeFileSync(file, '{bad')
  const corrupt = await cli(['doctor', '--home', home, '--url', url])
  assert.equal(corrupt.code, 1)
  assert.match(corrupt.text, /FAIL vector/)
})
