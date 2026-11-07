import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addFact, effectiveFacts, putCard, readCatalog } from '../src/catalog.mjs'
import { loadCorpus } from '../src/search.mjs'
import { fingerprint } from '../src/store.mjs'
import { completeEvent, createPendingEvent, readEvent, updateEventAssistant } from '../src/events.mjs'

function fixture() {
  const home=mkdtempSync(join(tmpdir(),'dba-catalog-'))
  mkdirSync(join(home,'ws')); mkdirSync(join(home,'events-v1'))
  writeFileSync(join(home,'stream.md'),'')
  writeFileSync(join(home,'ws','private.md'),'# Private title\nsecret body needle\n')
  writeFileSync(join(home,'ws','other.md'),'# Other\n')
  return home
}
const card=(file='ws/private.md')=>({file,topics:['nebula'],aliases:['星云'],entities:[],questions:[]})
const fact=(id, status='active', supersedes=[])=>({id,key:'choice',claim:`choice ${id}`,kind:'decision',status,source:{event_id:'e1',role:'user',quote:'I selected option A.'},supersedes,observed_at:`2026-11-0${id==='f1'?1:2}T00:00:00.000Z`})

function makeEvidence(home, user='I selected option A.') {
  createPendingEvent(home,{session_id:'test',id:'e1',user,at:'2026-11-01T00:00:00.000Z'})
  updateEventAssistant(home,'e1','Acknowledged.')
  return completeEvent(home,'e1')
}

test('card aliases retrieve the file name only, and exclusions still apply',()=>{
  const h=fixture(); try {
    putCard(h,card());
    const docs=loadCorpus(h); const d=docs.find(x=>x.source==='ws/private.md')
    assert.match(d.text,/星云/); assert.doesNotMatch(d.text,/secret body/)
    assert.equal(loadCorpus(h,{exclude:['private.md']}).some(x=>x.source==='ws/private.md'),false)
  } finally {rmSync(h,{recursive:true,force:true})}
})

test('fact evidence, superseding, retraction and conflicts are explicit',async()=>{
  const h=fixture(); try {
    makeEvidence(h)
    await addFact(h,fact('f1'))
    await addFact(h,fact('f2','retracted',['f1']))
    const c=JSON.parse((await import('node:fs')).readFileSync(join(h,'catalog.json'),'utf8'))
    assert.deepEqual(effectiveFacts(c),[])
    assert.deepEqual(effectiveFacts(c,{history:true}).map(x=>x.effective_status),['superseded','retracted'])
    assert.deepEqual(loadCorpus(h,{includeHistory:true}).filter(x=>x.source.startsWith('fact/')).map(x=>x.factStatus),['superseded','retracted'])
    await assert.rejects(()=>addFact(h,{...fact('f3'),source:{...fact('f3').source,quote:'Invented quote'}}),/evidence/)
    await assert.rejects(()=>addFact(h,{...fact('f4'),source:{...fact('f4').source,event_id:'missing'}}))
  } finally {rmSync(h,{recursive:true,force:true})}
})

test('unrelated active facts are marked as conflicts, and catalog evidence changes fingerprint',async()=>{
  const h=fixture(); try {
    makeEvidence(h)
    await addFact(h,fact('f1'))
    await addFact(h,{...fact('f2'),source:{...fact('f2').source,event_id:'e1'}})
    const docs=loadCorpus(h); assert.equal(docs.filter(d=>d.factStatus==='conflict').length,2)
    const before=fingerprint(h); const evidence=readEvent(h,'e1'); evidence.user+=' revised'; writeFileSync(join(h,'events-v1','e1.json'),JSON.stringify(evidence))
    const after=fingerprint(h); assert.notEqual(before,after)
  } finally {rmSync(h,{recursive:true,force:true})}
})

test('catalog uses memory home, rejects concurrent writes, and revalidates stored evidence',async()=>{
  const h=fixture(); try {
    makeEvidence(h)
    await addFact(h,fact('f1'))
    assert.equal(readCatalog(h,{strict:true}).facts.length,1)
    writeFileSync(join(h,'events-v1','e1.json'),JSON.stringify({...readEvent(h,'e1'),user:'changed archive'}))
    assert.throws(()=>readCatalog(h,{strict:true}),/evidence/)
    makeEvidence(h)
    writeFileSync(join(h,'.catalog.lock'),'locked')
    assert.throws(()=>putCard(h,card('ws/other.md')),/concurrently/)
  } finally {rmSync(h,{recursive:true,force:true})}
})

test('card paths cannot escape ws through symlinks',()=>{
  const h=fixture(), outside=join(h,'outside.md'); writeFileSync(outside,'# outside')
  try {
    try { symlinkSync(outside,join(h,'ws','escape.md'), 'file') }
    catch { return }
    assert.throws(()=>putCard(h,card('ws/escape.md')),/inside ws/)
    assert.throws(()=>putCard(h,card('ws/../outside.md')),/safe ws-relative|traverse/)
  } finally {rmSync(h,{recursive:true,force:true})}
})
