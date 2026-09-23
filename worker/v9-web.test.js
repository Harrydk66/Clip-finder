import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createV9Controller} from './v9-web.js';
import {runExperiment} from './replay-v9.js';
import {AXES} from './clip-worthiness.js';
import {publicJob} from '../lib/v9-public.js';

const id='9302f890-ae47-42ce-8bd2-de43b7252d51';
function fixture() {
  const candidates=Array.from({length:12},(_,i)=>({key:'c'+i,oldRank:i+1,summary:'Evento '+i,
    peak_seconds:i*100+20,start_seconds:i*100,end_seconds:i*100+60}));
  const snapshot={jobId:id,vodUrl:'https://kick.com/example',source:{kind:'pairwise_final',runId:'v83-fixture'},candidates,
    baselineTop10:candidates.slice(0,10),chunks:candidates.map(c=>({transcript_segments:[
      {start_seconds:c.start_seconds,end_seconds:c.start_seconds+3,text:'Qual é a prova?'},
      {start_seconds:c.start_seconds+3,end_seconds:c.end_seconds,text:'Aqui está. Resolvido.'}]}))};
  const job={id,status:'completed',algo_version:'V8.3',progress:100,result:{replayRunId:'v83-fixture',title:'Live salva',
    candidates:candidates.slice(0,10).map(c=>({seconds:c.peak_seconds,summary:c.summary})),checkpoint:{kept:true}}};
  const state={job,snapshot,pending:[],locked:false,calls:0,loads:0,failOn:0,writes:0};
  const deps={env:{OPENAI_API_KEY:'test',SUPABASE_URL:'https://db.invalid',SUPABASE_SERVICE_ROLE_KEY:'test'},
    getJob:async()=>structuredClone(job),saveResult:async(_id,result)=>{assert.ok(state.locked);state.writes++;job.result=structuredClone(result)},
    reserve:async()=>{if(state.locked)return null;state.locked=true;return {assertHeld(){assert.ok(state.locked)},async release(){state.locked=false}}},
    defer:fn=>state.pending.push(fn),snapshotLoader:async()=>{state.loads++;return structuredClone(snapshot)},
    experiment:(snap,options)=>runExperiment(snap,{...options,judge:async input=>{
      if(++state.calls===state.failOn)throw new Error('fixture model failure');
      const axis=score=>({score,reason:'Pergunta e resolução no trecho.',evidence:[{sourceId:input.segments[0].sourceId,quote:'Qual é a prova?'}]});
      return {judgment:{...Object.fromEntries(['eventValue',...AXES].map(k=>[k,axis(3)])),contextDependence:axis(0),
        decision:'Postaria',publishReason:'A pergunta é respondida.',missingContext:'',uncertainty:''}};
    }})};
  return {state,deps,controller:createV9Controller(deps),async drain(){while(state.pending.length)await state.pending.shift()()}};
}

test('web comparison persists progress and metrics without replacing the V8.3 result; repeated click is cached',async()=>{
  const h=fixture(),original=structuredClone(h.state.job);
  assert.equal((await h.controller.start(id)).cached,false);
  assert.equal(h.state.job.result.v9.status,'queued');assert.equal(h.state.locked,true);
  await assert.rejects(h.controller.start(id),/sendo processada/);
  await h.drain();const {v9,v9History,...result}=h.state.job.result;
  assert.deepEqual(result,original.result);assert.equal(h.state.job.status,'completed');assert.equal(h.state.job.algo_version,'V8.3');
  assert.equal(v9.status,'completed');assert.equal(v9.ranked.length,12);assert.equal(v9.metrics.v9.acceptanceAt10,null);
  assert.equal(h.state.locked,false);assert.equal(h.state.calls,12);assert.ok(h.state.writes>=14);
  assert.equal((await h.controller.start(id)).cached,true);assert.equal(h.state.calls,12);assert.equal(h.state.locked,false);
});

test('failed or restarted worker resumes persisted snapshot/cache, not transcription or discovery',async()=>{
  const h=fixture();h.state.failOn=3;await h.controller.start(id);await h.drain();
  assert.equal(h.state.job.result.v9.status,'failed');assert.equal(Object.keys(h.state.job.result.v9.cache).length,2);
  h.state.failOn=0;h.state.job.result.v9.status='running'; // Process died; lease has expired.
  const restarted=createV9Controller(h.deps);await restarted.start(id);await h.drain();
  assert.equal(h.state.calls,13);assert.equal(h.state.loads,1);assert.equal(h.state.job.result.v9.status,'completed');
});

test('manual votes persist, reject invalid/stale requests, and calculate acceptance only once fully rated',async()=>{
  const h=fixture();await h.controller.start(id);await h.drain();const v9=h.state.job.result.v9;
  await assert.rejects(h.controller.feedback(id,{key:'c0',label:'bad',snapshotHash:v9.snapshotHash}),/Use Postaria/);
  await assert.rejects(h.controller.feedback(id,{key:'c0',label:'Postaria',snapshotHash:'old'}),/mudou/);
  await assert.rejects(h.controller.feedback(id,{key:'unknown',label:'Postaria',snapshotHash:v9.snapshotHash}),/não pertence/);
  for(const row of v9.review)await h.controller.feedback(id,{key:row.key,label:'Postaria',snapshotHash:v9.snapshotHash});
  assert.equal(h.state.job.result.v9.metrics.v9.acceptanceAt10,1);
  assert.equal(h.state.job.result.v9.metrics.baseline.acceptanceAt10,1);
  assert.equal(h.state.calls,12);assert.equal(h.state.locked,false);
  h.state.job.result.replayRunId='another-run';
  await assert.rejects(h.controller.feedback(id,{key:'c0',label:'Talvez',snapshotHash:v9.snapshotHash}),/ranking anterior mudou/);
});

test('missing credentials, incomplete baseline and absent job fail before paid work and release reservation',async()=>{
  for(const change of [h=>delete h.deps.env.OPENAI_API_KEY,h=>h.state.job.status='ranking',h=>delete h.state.job.result.replayRunId]) {
    const h=fixture();change(h);await assert.rejects(h.controller.start(id));assert.equal(h.state.calls,0);assert.equal(h.state.locked,false);
  }
  const h=fixture();await assert.rejects(h.controller.start('bad'),/inválida/);assert.equal(h.state.locked,false);
});

test('new baseline archives previous comparison instead of reusing its votes',async()=>{
  const h=fixture();await h.controller.start(id);await h.drain();
  h.state.job.result.replayRunId='v83-next';h.state.snapshot.source.runId='v83-next';
  await h.controller.start(id);await h.drain();
  assert.equal(h.state.job.result.v9History.length,1);assert.equal(h.state.job.result.v9.baselineRunId,'v83-next');
  assert.equal(h.state.job.result.v9History[0].baselineRunId,'v83-fixture');assert.equal(h.state.calls,24);
});

test('polling returns useful progress/diagnostics, never the transcript snapshot, cache or archives',async()=>{
  const h=fixture();await h.controller.start(id);await h.drain();
  const out=publicJob(h.state.job),v9=out.result.v9;
  assert.equal(v9.done,12);assert.equal(v9.total,12);assert.equal(v9.baselineTop10.length,10);
  assert.equal(v9.snapshot,undefined);assert.equal(v9.cache,undefined);assert.equal(out.result.v9History,undefined);
  assert.equal(v9.ranked[0].diagnostics.decision,'Postaria');assert.ok(h.state.job.result.v9.snapshot);
});

test('Next V9 proxy uses server secret, forwards only expected fields and surfaces worker errors',async()=>{
  const source=readFileSync(new URL('../app/api/jobs/[id]/v9/route.js',import.meta.url),'utf8');
  let sent;
  const context=vm.createContext({Response,AbortSignal,process:{env:{WORKER_URL:'https://worker.invalid',WORKER_SECRET:'server-only'}},
    fetch:async(url,options)=>{sent={url,...options};return {status:202,json:async()=>({ok:true})}}});
  vm.runInContext(source.replaceAll('export async function','async function'),context);
  let response=await context.POST(null,{params:Promise.resolve({id})});assert.equal(response.status,202);
  assert.equal(sent.headers.Authorization,'Bearer server-only');assert.equal(sent.url,'https://worker.invalid/jobs/v9');
  response=await context.PATCH({json:async()=>({key:'c0',label:'Talvez',snapshotHash:'hash',id:'attacker',secret:'ignored'})},{params:{id}});
  assert.deepEqual(JSON.parse(sent.body),{id,key:'c0',label:'Talvez',snapshotHash:'hash'});
  context.fetch=async()=>({status:409,json:async()=>({error:'Ocupado'})});
  response=await context.POST(null,{params:{id}});assert.equal(response.status,409);
  response=await context.POST(null,{params:{id:'bad'}});assert.equal(response.status,400);
});
