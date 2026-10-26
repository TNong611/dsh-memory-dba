import { parentPort } from 'node:worker_threads'
import { dirname } from 'node:path'
import { statSync } from 'node:fs'
import { embed } from './embed.mjs'
import { cosineInt8, encodeVector, loadVectorCache } from './vector.mjs'

/** The cache is re-parsed only when the file changes; each turn otherwise reuses it. */
let memo

function cacheFor(cachePath) {
  const { mtimeMs } = statSync(cachePath)
  if (!memo || memo.path !== cachePath || memo.mtimeMs !== mtimeMs) {
    memo = { path: cachePath, mtimeMs, cache: loadVectorCache(dirname(dirname(cachePath))) }
  }
  return memo.cache
}

parentPort.on('message', async ({ query, cachePath, keys, topK, url, model, timeoutMs, keepAlive, sab }) => {
  const header = new Int32Array(sab)
  try {
    const cache = cacheFor(cachePath)
    if (cache.model !== model) throw new Error('model mismatch')
    const vector = await embed(query, { url, model, timeoutMs, keepAlive })
    if (vector.length !== cache.dim) throw new Error('dimension mismatch')
    const encoded = encodeVector(vector)
    const hits = keys.flatMap((key, index) => cache.entries[key] ? [{ index, score: cosineInt8(encoded, cache.entries[key]) }] : [])
      .sort((left, right) => right.score - left.score || left.index - right.index).slice(0, Math.min(8, topK))
    const floats = new Float32Array(sab)
    for (let index = 0; index < hits.length; index += 1) {
      header[2 + index * 2] = hits[index].index
      floats[3 + index * 2] = hits[index].score
    }
    header[1] = hits.length
    Atomics.store(header, 0, 1)
  } catch { Atomics.store(header, 0, -1) }
  Atomics.notify(header, 0)
})
