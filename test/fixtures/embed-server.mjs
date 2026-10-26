import { createServer } from 'node:http'
import { parentPort } from 'node:worker_threads'

const vector = [1, 0.5, -0.25, 0, 0, 0, 0, 0]
const server = createServer(async (request, response) => {
  for await (const chunk of request) void chunk
  if (request.url.startsWith('/slow/')) {
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ embeddings: [vector] }))
})
server.listen(0, '127.0.0.1', () => parentPort.postMessage(`http://127.0.0.1:${server.address().port}`))
