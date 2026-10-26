/**
 * Filesystem layout for the three memory layers.
 *
 *   <home>/core.md          core memory, injected in full every turn
 *   <home>/stream.md        one line per completed turn
 *   <home>/ws/<area>.md     detailed notes, retrieved only
 *   <home>/.index/          derived caches (safe to delete)
 *
 * The directory is meant to be versioned as a whole: copy it, commit it, or
 * point two harness installs at the same path on different operating systems.
 * Nothing here stores an absolute path.
 */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const CORE_FILE = 'core.md'
export const STREAM_FILE = 'stream.md'
export const WS_DIR = 'ws'
export const INDEX_DIR = '.index'

const DEFAULT_HOME = platform() === 'win32'
  ? join(homedir(), 'AppData', 'Local', 'dsh-memory-dba')
  : join(homedir(), '.dsh-memory-dba')

/** NUL and control bytes make a layer unreadable; keep tabs/newlines and all emoji. */
const BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g

export function resolveHome(home) {
  const chosen = home || process.env.DSH_MEMORY_HOME || DEFAULT_HOME
  return resolve(chosen.replace(/^~(?=$|[\\/])/, homedir()))
}

/**
 * Create the layer files on first run. Existing files are never touched, so
 * initializing an installed package cannot overwrite a real memory directory.
 *
 * @param {string} home Absolute memory directory.
 * @returns {{created: string[], existed: string[]}} What the call changed.
 */
export function ensureLayout(home) {
  const created = []
  const existed = []
  mkdirSync(home, { recursive: true })
  mkdirSync(join(home, WS_DIR), { recursive: true })
  mkdirSync(join(home, INDEX_DIR), { recursive: true })

  const seeds = [
    [CORE_FILE, '# Core memory\n\n'],
    [STREAM_FILE, '# Memory stream\n\n'],
  ]
  for (const [name, body] of seeds) {
    const file = join(home, name)
    if (existsSync(file)) {
      existed.push(name)
      continue
    }
    writeFileSync(file, body, 'utf8')
    created.push(name)
  }
  return { created, existed }
}

/** UTF-8 byte length, the unit every budget in this package uses. */
export function bytes(text) {
  return Buffer.byteLength(text, 'utf8')
}

export class MissingLayer extends Error {
  constructor(file) {
    super(`memory layer missing: ${file}`)
    this.name = 'MissingLayer'
    this.file = file
  }
}

/**
 * Read one layer as text. Failure is reported as a distinct error type rather
 * than an empty string, so callers can tell "no memory yet" from "read broke".
 *
 * @param {string} home Absolute memory directory.
 * @param {string} name Layer file name relative to `home`.
 * @returns {string} File contents without a BOM.
 */
export function readLayer(home, name) {
  const file = join(home, name)
  let raw
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file))
  } catch (error) {
    if (error?.code === 'ENOENT') throw new MissingLayer(file)
    throw error
  }
  return raw.replace(/^\uFEFF/, '')
}

/** Atomic-ish replacement: write a sibling temp file, then rename. */
export function writeLayer(home, name, text) {
  const file = join(home, name)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text.replace(BAD_CHARS, ''), 'utf8')
  renameSync(tmp, file)
}

/** Append a single line; creates the file when absent. */
export function appendLayer(home, name, line) {
  const file = join(home, name)
  mkdirSync(dirname(file), { recursive: true })
  let needsNewline = false
  if (existsSync(file)) {
    const fd = openSync(file, 'r')
    try {
      const { size } = fstatSync(fd)
      if (size > 0) {
        const last = Buffer.alloc(1)
        readSync(fd, last, 0, 1, size - 1)
        needsNewline = last[0] !== 0x0a
      }
    } finally {
      closeSync(fd)
    }
  }
  const clean = line.replace(BAD_CHARS, '')
  writeFileSync(file, `${needsNewline ? '\n' : ''}${clean}\n`, { encoding: 'utf8', flag: 'a' })
}

/**
 * Cut text to a byte budget without splitting a UTF-8 sequence or a lone
 * surrogate, and mark the truncation so a reader never mistakes a prefix for
 * the whole layer.
 *
 * @param {string} text Source text.
 * @param {number} limitBytes Maximum UTF-8 bytes.
 * @param {string} [marker] Suffix appended when text was cut.
 */
export function clipBytes(text, limitBytes, marker = '\n\n[...clipped to fit the memory budget]') {
  limitBytes = Number.isFinite(limitBytes) ? Math.max(0, Math.floor(limitBytes)) : 0
  if (bytes(text) <= limitBytes) return { text, clipped: false }
  if (bytes(marker) > limitBytes) marker = clipBytes(marker, limitBytes, '').text
  const reserve = bytes(marker)
  const budget = Math.max(0, limitBytes - reserve)
  let used = 0
  let out = ''
  for (const ch of text) {
    const size = bytes(ch)
    if (used + size > budget) break
    out += ch
    used += size
  }
  return { text: out + marker, clipped: true }
}

/** Snapshot used to invalidate derived indexes without watching files. */
export function fingerprint(home) {
  const parts = []
  let names = []
  try {
    names = readdirSync(join(home, WS_DIR)).filter(name => name.endsWith('.md')).sort()
  } catch { /* An unavailable workspace has no cacheable entries. */ }
  for (const name of [CORE_FILE, STREAM_FILE, ...names.map(name => `${WS_DIR}/${name}`)]) {
    try {
      const st = statSync(join(home, name))
      parts.push(JSON.stringify([name, st.size, st.mtimeMs]))
    } catch {
      parts.push(`${name}:-`)
    }
  }
  return parts.join('|')
}
