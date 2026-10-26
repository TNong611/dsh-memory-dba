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
import { buildCore, buildHits } from '../src/assemble.mjs'
import { corpusStats, fitHits, loadCorpus, search } from '../src/search.mjs'
import { ensureLayout, resolveHome } from '../src/store.mjs'
import { appendTurn } from '../src/stream.mjs'
import { isBlankQuery } from '../src/tokenize.mjs'

const USAGE = `dsh-memory-dba <command> [options]

Commands:
  init                       create the memory directory and layer files
  recall <query>             rank memory entries for a query
  write --user --assistant   append one turn to the stream
  stats                      per-layer byte counts
  doctor                     validate layout and retrieval

Options:
  --home DIR                 memory directory (default: DSH_MEMORY_HOME or the platform default)
  --top-k N                  number of hits (default 5)
  --json                     machine-readable output`

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      home: { type: 'string', default: '' },
      'top-k': { type: 'string', default: '5' },
      user: { type: 'string', default: '' },
      assistant: { type: 'string', default: '' },
      json: { type: 'boolean', default: false },
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
      const result = search(loadCorpus(home), query, { topK })
      const hits = fitHits(result.hits, 6 * 1024)
      emit(
        { query, applied: result.applied, corpusDates: result.corpusDates, hits },
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

    case 'stats': {
      const stats = corpusStats(home)
      const lines = Object.entries(stats.layers).map(([name, size]) => `${name.padEnd(24)} ${(size / 1024).toFixed(1)} KB`)
      emit({ home, ...stats }, [`memory home: ${home}`, ...lines, `documents: ${stats.docs}`, `total: ${(stats.bytes / 1024).toFixed(1)} KB`].join('\n'))
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
  main()
} catch (error) {
  console.error(`dsh-memory-dba: ${error.message}`)
  process.exitCode = 2
}
