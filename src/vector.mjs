import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'

export class VectorCorrupt extends Error {
  constructor() {
    super('invalid vector cache')
    this.name = 'VectorCorrupt'
  }
}

export class MissingVectors extends Error {
  constructor() {
    super('vector cache missing')
    this.name = 'MissingVectors'
  }
}

export function docKey(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

export function encodeVector(vector) {
  if (!(vector instanceof Float32Array) || !vector.length || !vector.every(Number.isFinite)) throw new VectorCorrupt()
  let maximum = 0
  for (const value of vector) maximum = Math.max(maximum, Math.abs(value))
  const scale = maximum / 127
  const quantized = Int8Array.from(vector, value => scale ? Math.round(value / scale) : 0)
  return { s: scale, q: Buffer.from(quantized.buffer).toString('base64') }
}

function quantized(entry) {
  if (!entry || typeof entry.s !== 'number' || !Number.isFinite(entry.s) || entry.s < 0 || typeof entry.q !== 'string' || !entry.q.length) throw new VectorCorrupt()
  const buffer = Buffer.from(entry.q, 'base64')
  if (buffer.toString('base64') !== entry.q) throw new VectorCorrupt()
  const values = new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (values.some(value => value === -128 || (entry.s === 0 && value !== 0))) throw new VectorCorrupt()
  return values
}

export function decodeVector(entry) {
  return Float32Array.from(quantized(entry), value => value * entry.s)
}

export function cosineInt8(left, right) {
  const first = quantized(left)
  const second = quantized(right)
  if (first.length !== second.length) throw new VectorCorrupt()
  let dot = 0
  let firstNorm = 0
  let secondNorm = 0
  for (let index = 0; index < first.length; index += 1) {
    dot += first[index] * second[index]
    firstNorm += first[index] ** 2
    secondNorm += second[index] ** 2
  }
  return firstNorm && secondNorm ? Math.max(-1, Math.min(1, dot / Math.sqrt(firstNorm * secondNorm))) : 0
}

function validateCache(cache) {
  if (!cache || cache.version !== 1 || typeof cache.model !== 'string' || !cache.model.trim() || !Number.isInteger(cache.dim) || cache.dim < 1 || !cache.entries || typeof cache.entries !== 'object' || Array.isArray(cache.entries)) throw new VectorCorrupt()
  for (const [key, entry] of Object.entries(cache.entries)) {
    if (!/^[a-f0-9]{40}$/.test(key) || quantized(entry).length !== cache.dim) throw new VectorCorrupt()
  }
  return cache
}

export function loadVectorCache(home) {
  let raw
  try { raw = readFileSync(join(home, '.vec', 'embeddings.json'), 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') throw new MissingVectors()
    throw error
  }
  try { return validateCache(JSON.parse(raw)) } catch { throw new VectorCorrupt() }
}

export function saveVectorCache(home, cache) {
  validateCache(cache)
  const file = join(home, '.vec', 'embeddings.json')
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  const clean = { version: 1, model: cache.model, dim: cache.dim, entries: Object.fromEntries(Object.entries(cache.entries).map(([key, entry]) => [key, { s: entry.s, q: entry.q }])) }
  writeFileSync(temporary, JSON.stringify(clean), 'utf8')
  renameSync(temporary, file)
}

let worker
// After a failed lookup, skip semantic recall briefly: a down or cold embedder must
// not cost the synchronous budget on every single turn.
const coolDown = new Map()

export function semanticRecall(home, query, keys, { topK = 8, url = 'http://127.0.0.1:11434', model = 'bge-m3', timeoutMs = 1500, keepAlive = '30m' } = {}) {
  const started = performance.now()
  try {
    const cachePath = join(home, '.vec', 'embeddings.json')
    if (!keys.length || !existsSync(cachePath) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return null
    const coolKey = `${url}|${model}`
    if ((coolDown.get(coolKey) || 0) > started) return null
    if (!worker) {
      const instance = new Worker(new URL('./vector-worker.mjs', import.meta.url))
      instance.on('error', () => { if (worker === instance) worker = undefined })
      instance.on('exit', () => { if (worker === instance) worker = undefined })
      instance.unref()
      worker = instance
    }
    const sab = new SharedArrayBuffer(8 + 8 * 8)
    const header = new Int32Array(sab)
    worker.postMessage({ query, cachePath, keys, topK: Math.min(8, Math.max(1, Math.floor(topK))), url, model, timeoutMs, keepAlive, sab })
    const remaining = timeoutMs - (performance.now() - started)
    if (remaining <= 0 || Atomics.wait(header, 0, 0, remaining) === 'timed-out' || Atomics.load(header, 0) !== 1) {
      coolDown.set(coolKey, performance.now() + 60_000)
      return null
    }
    const floats = new Float32Array(sab)
    const result = new Map()
    for (let index = 0; index < header[1]; index += 1) result.set(keys[header[2 + index * 2]], floats[3 + index * 2])
    coolDown.delete(coolKey)
    return result
  } catch { return null }
}
