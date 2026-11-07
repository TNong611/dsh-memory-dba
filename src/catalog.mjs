import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { readEvent as readArchivedEvent } from './events.mjs'

export const CATALOG_FILE = 'catalog.json'
const MAX_TEXT = 240
const FIELDS = ['topics', 'aliases', 'entities', 'questions']
const cleanString = (s, max = MAX_TEXT) => typeof s === 'string' && s.trim().length > 0 && [...s].length <= max && !/[\u0000-\u001f\u007f]/.test(s)
const validTimestamp = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z'))

export function validateCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card) || typeof card.file !== 'string' || !/^ws\/(?!\.)[^\\/:*?"<>|\u0000-\u001f]+\.md$/.test(card.file)) throw new Error('card.file must be a safe ws-relative .md path')
  if (card.file.slice(3).split('/').some(part => part === '.' || part === '..')) throw new Error('card.file cannot traverse directories')
  for (const field of FIELDS) {
    if (!Array.isArray(card[field]) || card[field].length > 32 || !card[field].every(v => cleanString(v))) throw new Error(`card.${field} must be an array of up to 32 short strings`)
  }
  if (Object.keys(card).some(k => !['file', ...FIELDS].includes(k))) throw new Error('card has unknown fields')
  return card
}
export function validateFact(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error('fact must be an object')
  if (!cleanString(f.id, 100) || !/^[A-Za-z0-9_-]+$/.test(f.id) || !cleanString(f.key, 160) || !cleanString(f.claim, 600)) throw new Error('fact id/key/claim is invalid')
  if (!['decision','constraint','result','plan'].includes(f.kind) || !['active','retracted'].includes(f.status)) throw new Error('invalid fact kind/status')
  if (!f.source || Object.keys(f.source).sort().join(',') !== 'event_id,quote,role' || !cleanString(f.source.event_id, 128) || !/^[A-Za-z0-9_-]+$/.test(f.source.event_id) || !['user','assistant'].includes(f.source.role) || !cleanString(f.source.quote, 1200)) throw new Error('invalid fact source')
  if (!Array.isArray(f.supersedes) || new Set(f.supersedes).size !== f.supersedes.length || f.supersedes.some(x => !cleanString(x,100) || !/^[A-Za-z0-9_-]+$/.test(x)) || !validTimestamp(f.observed_at)) throw new Error('invalid supersedes/observed_at')
  if (Object.keys(f).some(k => !['id','key','claim','kind','status','source','supersedes','observed_at'].includes(k))) throw new Error('fact has unknown fields')
  return f
}
export function readCatalog(home, { strict = false } = {}) {
  const p = join(home, CATALOG_FILE)
  if (!existsSync(p)) return { version: 1, cards: [], facts: [] }
  try {
    const c = JSON.parse(readFileSync(p, 'utf8'))
    if (!c || Object.keys(c).sort().join(',') !== 'cards,facts,version' || c.version !== 1 || !Array.isArray(c.cards) || !Array.isArray(c.facts)) throw new Error('catalog must have version:1, cards and facts')
    c.cards.forEach(validateCard); c.facts.forEach(validateFact)
    if (new Set(c.cards.map(x=>x.file)).size !== c.cards.length || new Set(c.facts.map(x=>x.id)).size !== c.facts.length) throw new Error('duplicate catalog card or fact id')
    const byId = new Map(c.facts.map(f=>[f.id,f]))
    const superseded = new Set()
    for (const [index, f] of c.facts.entries()) for (const id of f.supersedes) {
      const old = byId.get(id)
      if (!old || c.facts.findIndex(x => x.id === id) >= index || old.key !== f.key) throw new Error(`invalid supersedes reference ${id}`)
      superseded.add(id)
    }
    const visit = (id, path = new Set()) => { if(path.has(id)) throw new Error('supersedes cycle'); path.add(id); for(const p of byId.get(id)?.supersedes||[]) visit(p,path); path.delete(id) }
    c.facts.forEach(f=>{
      visit(f.id)
      const ev=readArchivedEvent(home,f.source.event_id)
      if (!ev || ev.version !== 1 || typeof ev[f.source.role] !== 'string' || !ev[f.source.role].includes(f.source.quote)) throw new Error(`invalid evidence quote/event for fact ${f.id}`)
    })
    return c
  } catch (e) { if (strict) throw e; throw Object.assign(new Error(`catalog error: ${e.message}`), { cause: e }) }
}
function safeWorkspaceFile(home, rel) {
  const root = realpathSync(join(home, 'ws'))
  const candidate = resolve(home, rel)
  const real = realpathSync(candidate)
  if (!real.startsWith(root + sep) || !lstatSync(candidate).isFile()) throw new Error('card file must resolve to a regular file inside ws')
}
function withCatalogLock(home, action) {
  const dir = home; mkdirSync(dir, {recursive:true})
  const lock = join(dir, '.catalog.lock')
  let fd
  try { fd = requireOpen(lock) } catch { throw new Error('catalog is being updated concurrently') }
  try {
    return action(dir)
  } finally { closeLock(fd,lock) }
}
function requireOpen(p) { return openSync(p, 'wx') }
function closeLock(fd,p) { closeSync(fd); try { unlinkSync(p) } catch {} }
export function atomicWriteCatalog(home, catalog) {
  return withCatalogLock(home, dir => {
    const p = join(dir, CATALOG_FILE); const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, `${JSON.stringify(catalog,null,2)}\n`, {flag:'wx'}); renameSync(tmp,p)
  })
}
export function putCard(home, card, { exclude=[] }={}) {
  validateCard(card); if(exclude.includes(card.file) || exclude.includes(card.file.slice(3))) throw new Error('card is excluded')
  safeWorkspaceFile(home, card.file)
  return withCatalogLock(home, dir => {
    const c=readCatalog(home); const i=c.cards.findIndex(x=>x.file===card.file)
    if(i<0)c.cards.push(card); else c.cards[i]=card
    const p=join(dir,CATALOG_FILE), tmp=`${p}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, `${JSON.stringify(c,null,2)}\n`, {flag:'wx'})
    renameSync(tmp,p); return card
  })
}
export async function addFact(home, fact, { readEvent }={}) {
  validateFact(fact); const c=readCatalog(home)
  if(c.facts.some(x=>x.id===fact.id)) throw new Error('fact id already exists')
  const prior=new Map(c.facts.map(x=>[x.id,x]))
    for(const id of fact.supersedes){const old=prior.get(id);if(!old||old.key!==fact.key)throw new Error(`invalid supersedes reference ${id}`)}
  const ev=readEvent ? await readEvent(home,fact.source.event_id) : readArchivedEvent(home,fact.source.event_id)
  if(!ev || ev.version!==1||ev.id!==fact.source.event_id||typeof ev[fact.source.role]!=='string'||!ev[fact.source.role].includes(fact.source.quote)) throw new Error('fact evidence event/quote does not validate')
  return withCatalogLock(home, dir => {
    const latest=readCatalog(home)
    if(latest.facts.some(x=>x.id===fact.id)) throw new Error('fact id already exists')
    const byId=new Map(latest.facts.map(x=>[x.id,x]))
    for(const id of fact.supersedes){const old=byId.get(id);if(!old||old.key!==fact.key)throw new Error(`invalid supersedes reference ${id}`)}
    latest.facts.push(fact)
    const p=join(dir,CATALOG_FILE), tmp=`${p}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp,`${JSON.stringify(latest,null,2)}\n`,{flag:'wx'}); renameSync(tmp,p); return fact
  })
}
export function effectiveFacts(catalog, { history=false }={}) {
  const superseded=new Set(catalog.facts.flatMap(f=>f.supersedes));
  const rows=catalog.facts.map(f=>({...f,effective_status:f.status==='retracted'?'retracted':superseded.has(f.id)?'superseded':'active'}))
  const active=rows.filter(f=>f.effective_status==='active')
  const counts=new Map(); for(const f of active)counts.set(f.key,(counts.get(f.key)||0)+1)
  for(const f of rows) if(f.effective_status==='active'&&counts.get(f.key)>1)f.effective_status='conflict'
  return history?rows:rows.filter(f=>['active','conflict'].includes(f.effective_status))
}
