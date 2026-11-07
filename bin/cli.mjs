#!/usr/bin/env node
/**
 * Small operator CLI for the memory directory. The plugin never needs it, but a
 * person debugging retrieval does: same functions, visible output.
 *
 *   dsh-memory-dba init [--home DIR]
 *   dsh-memory-dba recall "query" [--top-k 5] [--home DIR]
 *   dsh-memory-dba write --user "..." --assistant "..." [--home DIR]
 *   dsh-memory-dba stats [--home DIR]
 *   dsh-memory-dba doctor [--home DIR]
 */

import { parseArgs } from 'node:util'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { buildCore, buildHits } from '../src/assemble.mjs'
import { corpusStats, fitHits, loadCorpus, search } from '../src/search.mjs'
import { ensureLayout, resolveHome } from '../src/store.mjs'
import { appendTurn } from '../src/stream.mjs'
import { isBlankQuery } from '../src/tokenize.mjs'
import { recall } from '../src/index.mjs'
import { embed } from '../src/embed.mjs'
import { docKey, encodeVector, loadVectorCache, saveVectorCache, semanticRecall, MissingVectors, VectorCorrupt } from '../src/vector.mjs'
import { addFact, effectiveFacts, putCard, readCatalog } from '../src/catalog.mjs'
import { readFileSync } from 'node:fs'
import { readEvent } from '../src/events.mjs'

const USAGE = `dsh-memory-dba <command> [options]

Commands:
  init                       create the memory directory and layer files
  recall <query>             rank memory entries for a query
  write --user --assistant   append one turn to the stream
  stats                      per-layer byte counts
  doctor                     validate layout and retrieval
  index                      build the optional semantic vector cache
  card-put --input FILE      add or replace one navigation card
  fact-add --input FILE      add one evidence-checked fact
  facts [query] [--history]  search facts, optionally including superseded records
  event --id ID              display one complete evidence event

Options:
  --home DIR                 memory directory (default: DSH_MEMORY_HOME or the platform default)
  --top-k N                  number of hits (default 5)
  --url URL                  Ollama URL (default http://127.0.0.1:11434)
  --model NAME               embedding model (default bge-m3)
  --json                     machine-readable output`

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      home: { type: 'string', default: '' },
      'top-k': { type: 'string', default: '5' },
      user: { type: 'string', default: '' },
      assistant: { type: 'string', default: '' },
      json: { type: 'boolean', default: false },
      url: { type: 'string', default: 'http://127.0.0.1:11434' },
      model: { type: 'string', default: 'bge-m3' },
      input: { type: 'string', default: '' },
      id: { type: 'string', default: '' },
      history: { type: 'boolean', default: false },
      semantic: { type: 'boolean', default: false },
    },
  })

  const [command, ...rest] = positionals
  const home = resolveHome(values.home)

  /** Print a JSON value when --json is set, otherwise call the text printer. */
  const emit = (data, text) => {
    if (values.json) console.log(JSON.stringify(data, null, 2))
    else console.log(text)
  }

  switch (command) {
    case 'init': {
      const result = ensureLayout(home)
      emit({ home, ...result }, `memory home: ${home}\ncreated: ${result.created.join(', ') || '(none)'}\nexisting: ${result.existed.join(', ') || '(none)'}`)
      break
    }

    case 'recall': {
      const query = rest.join(' ').trim()
      if (isBlankQuery(query)) {
        console.error('recall needs a query')
        process.exitCode = 2
        break
      }
      const topK = Number(values['top-k'])
      if (!Number.isInteger(topK) || topK < 1) throw new Error('--top-k must be a positive integer')
      const corpus = loadCorpus(home)
      const semantic = values.semantic ? semanticRecall(home, query, corpus.map(doc => docKey(doc.text)), { topK, url: values.url, model: values.model }) : null
      const result = recall(corpus, query, { topK, semantic })
      const hits = fitHits(result.hits, 6 * 1024)
      emit(
        { query, applied: result.applied, relaxed: result.relaxed, corpusDates: result.corpusDates, hits },
        hits.length
          ? hits.map(hit => `${hit.score.toFixed(2)}  [${hit.source}:${hit.line}]  ${hit.text.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n')
          : '(no hits)',
      )
      break
    }

    case 'write': {
      const outcome = appendTurn(home, { user: values.user, assistant: values.assistant })
      emit(outcome, outcome.written ? outcome.line : `not written: ${outcome.reason}`)
      if (!outcome.written) process.exitCode = 1
      break
    }

    case 'card-put': {
      if (!values.input) throw new Error('card-put requires --input JSON_FILE')
      const card = JSON.parse(readFileSync(values.input, 'utf8'))
      emit(putCard(home, card), `saved card ${card.file}`)
      break
    }

    case 'fact-add': {
      if (!values.input) throw new Error('fact-add requires --input JSON_FILE')
      const fact = JSON.parse(readFileSync(values.input, 'utf8'))
      const result = await addFact(home, fact)
      emit(result, `saved fact ${result.id}`)
      break
    }

    case 'facts': {
      const query = rest.join(' ').trim()
      const rows = effectiveFacts(readCatalog(home, { strict: true }), { history: values.history })
      const docs = rows.map(f => ({...f, text: `${f.key} ${f.claim} ${f.kind} ${f.source.role}_reported ${f.source.event_id} ${f.effective_status}`}))
      const found = query ? search(docs.map((d,i)=>({source:`fact/${d.id}`,line:1,text:d.text,date:d.observed_at,record:d})), query, {topK:1000}).hits.map(h=>h.record) : rows
      emit(found, found.map(f=>`${f.effective_status} ${f.key}: ${f.claim} [${f.source.role}_reported, event ${f.source.event_id}]`).join('\n') || '(no facts)')
      break
    }

    case 'event': {
      if (!values.id) throw new Error('event requires --id ID')
      const event = readEvent(home, values.id)
      if (!event || event.version !== 1 || event.id !== values.id) throw new Error('event not found or invalid')
      emit(event, JSON.stringify(event, null, 2))
      break
    }

    case 'stats': {
      const stats = corpusStats(home)
      const lines = Object.entries(stats.layers).map(([name, size]) => `${name.padEnd(24)} ${(size / 1024).toFixed(1)} KB`)
      try {
        stats.vectorBytes = statSync(join(home, '.vec', 'embeddings.json')).size
        lines.push(`vector cache             ${stats.vectorBytes} B`)
      } catch (error) { if (error?.code !== 'ENOENT') throw error }
      emit({ home, ...stats }, [`memory home: ${home}`, ...lines, `documents: ${stats.docs}`, `total: ${(stats.bytes / 1024).toFixed(1)} KB`].join('\n'))
      break
    }

    case 'index': {
      const started = Date.now()
      const corpus = loadCorpus(home, { strict: true })
      const unique = [...new Map(corpus.map(doc => [docKey(doc.text), doc.text])).entries()]
      const cache = { version: 1, model: values.model, dim: 1024, entries: {} }
      let cursor = 0
      let dimension = null
      const options = { url: values.url, model: values.model, timeoutMs: 30000 }
      if (!unique.length) cache.dim = (await embed('memory', options)).length
      await Promise.all(Array.from({ length: Math.min(4, unique.length) }, async () => {
        while (cursor < unique.length) {
          const [key, text] = unique[cursor++]
          const vector = await embed(text, options)
          if (dimension !== null && dimension !== vector.length) throw new Error('embedder returned inconsistent dimensions')
          dimension = vector.length
          cache.dim = dimension
          cache.entries[key] = encodeVector(vector)
        }
      }))
      saveVectorCache(home, cache)
      const elapsed = Date.now() - started
      const skipped = corpus.length - unique.length
      emit({ indexed: unique.length, elapsedMs: elapsed, skipped }, `indexed ${unique.length} docs in ${elapsed}ms (${skipped} skipped)`)
      break
    }

    case 'doctor': {
      const checks = []
      try {
        ensureLayout(home)
        checks.push({ name: 'layout', ok: true })
      } catch (error) {
        checks.push({ name: 'layout', ok: false, detail: error.message })
      }
      try {
        const core = buildCore(home, { coreLimitKB: 15 })
        checks.push({ name: 'core-budget', ok: Buffer.byteLength(core.text) <= 15 * 1024, detail: `${Buffer.byteLength(core.text)}B${core.clipped ? ' (clipped)' : ''}` })
      } catch (error) {
        checks.push({ name: 'core-budget', ok: false, detail: error.message })
      }
      const started = Date.now()
      let corpus = []
      try {
        corpus = loadCorpus(home, { strict: true })
        checks.push({ name: 'corpus', ok: true, detail: `${corpus.length} docs in ${Date.now() - started}ms` })
      } catch (error) {
        checks.push({ name: 'corpus', ok: false, detail: error.message })
      }
      try {
        const probe = buildHits(search(corpus, 'memory', { topK: 3 }).hits, { budgetKB: 6 })
        checks.push({ name: 'retrieval', ok: true, detail: `${Buffer.byteLength(probe.text)}B` })
      } catch (error) {
        checks.push({ name: 'retrieval', ok: false, detail: error.message })
      }
      try {
        const cache = loadVectorCache(home)
        const coverage = corpus.filter(doc => Object.hasOwn(cache.entries, docKey(doc.text))).length
        checks.push({ name: 'vector', ok: true, detail: `${Object.keys(cache.entries).length}/${corpus.length} entries/documents; ${coverage}/${corpus.length} covered` })
      } catch (error) {
        if (error instanceof MissingVectors) {
          let available = false
          try {
            await embed('memory', { url: values.url, model: values.model, timeoutMs: 400 })
            available = true
          } catch {}
          checks.push({ name: 'vector', ok: true, detail: `optional: cache missing (0/${corpus.length} entries/documents); embedder ${available ? 'available; run index' : 'unavailable'}` })
        } else {
          checks.push({ name: 'vector', ok: !(error instanceof VectorCorrupt), detail: error instanceof VectorCorrupt ? error.message : `optional: ${error.message}` })
        }
      }
      const ok = checks.every(check => check.ok)
      emit({ home, ok, checks }, checks.map(check => `${check.ok ? 'ok  ' : 'FAIL'} ${check.name.padEnd(14)} ${check.detail || ''}`).join('\n'))
      if (!ok) process.exitCode = 1
      break
    }

    default:
      console.log(USAGE)
      process.exitCode = 2
  }
}

try {
  await main()
} catch (error) {
  console.error(`dsh-memory-dba: ${error.message}`)
  process.exitCode = 2
}
