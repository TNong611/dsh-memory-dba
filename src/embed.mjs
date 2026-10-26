export class EmbedUnavailable extends Error {
  constructor(message = 'embedder unavailable') {
    super(message)
    this.name = 'EmbedUnavailable'
  }
}

export async function embed(text, { url = 'http://127.0.0.1:11434', model = 'bge-m3', timeoutMs = 1200, keepAlive = '30m' } = {}) {
  try {
    const signal = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)))
    const base = url.replace(/\/+$/, '')
    const request = (path, body) => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal,
    })
    const shared = keepAlive ? { keep_alive: keepAlive } : {}
    let response = await request('/api/embed', { model, input: text, ...shared })
    let legacy = false
    if (response.status === 404) {
      await response.body?.cancel()
      legacy = true
      response = await request('/api/embeddings', { model, prompt: text, ...shared })
    }
    if (!response.ok) throw new EmbedUnavailable(`embedder HTTP ${response.status}`)
    const body = await response.json()
    const values = legacy ? body?.embedding : Array.isArray(body?.embeddings) ? body.embeddings[0] : null
    if (!Array.isArray(values) || !values.length || !values.every(value => typeof value === 'number' && Number.isFinite(value))) throw new EmbedUnavailable('invalid embedding response')
    const vector = Float32Array.from(values)
    if (!vector.every(Number.isFinite)) throw new EmbedUnavailable('invalid embedding values')
    return vector
  } catch (error) {
    if (error instanceof EmbedUnavailable) throw error
    throw new EmbedUnavailable(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'embedder timed out' : 'embedder unavailable')
  }
}
