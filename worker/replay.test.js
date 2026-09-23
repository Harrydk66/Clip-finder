import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {publicJob} from '../lib/v9-public.js';

const source=readFileSync(new URL('./server.js',import.meta.url),'utf8');
const vod='https://kick.com/example/videos/01a0b1e7-9b88-7754-b1e2-b2c97c9500b1';
const id='11111111-1111-1111-1111-111111111111';
function harness(overrides={}){
  const job={id,vod_url:vod,status:'failed',progress:97,stage:'V8.2 • replay falhou',error:'goldens.map is not a function',result:{title:'Saved VOD',checkpoint:{preserve:true}},...overrides};
  const chunks=[{id:'chunk',start_seconds:0,end_seconds:24000,status:'completed',transcript_segments:[{start_seconds:8000,end_seconds:8400,text:'Saved transcript'}]}];
  const candidates=[8040,8379].map(peak_seconds=>({peak_seconds,start_seconds:peak_seconds-30,end_seconds:peak_seconds+30,summary:'Saved event',participants:[]}));
  const requests=[],patches=[],trace=[],routes=new Map(),pending=[];
  const reply=data=>({ok:true,json:async()=>structuredClone(data),text:async()=>JSON.stringify(data)});
  const fetch=async(url,options={})=>{
    const method=options.method||'GET',body=options.body?JSON.parse(options.body):null;
    requests.push({url,method,body});
    if(url.includes('/analysis_jobs')){
      if(method==='PATCH'){patches.push(body);Object.assign(job,body)}
      return reply([job]);
    }
    if(url.includes('/vod_chunks')){assert.equal(method,'GET','transcript/checkpoints must be read-only');return reply(chunks)}
    if(url.includes('/clip_candidates')){assert.ok(['GET','PATCH'].includes(method),'no deletion or rediscovery');return reply(method==='GET'?candidates:[])}
    if(url.includes('/candidate_trace')){assert.equal(method,'POST');trace.push(...body);return reply([])}
    if(url.includes('/playback'))return reply({playback_url:{vod:'https://fixture.invalid/video'},video_session:{video_duration:24000}});
    if(url.endsWith('/chat/completions'))return reply({choices:[{message:{content:JSON.stringify({assignments:[],order:[{id:0,score:95},{id:1,score:90}],eventValue:4,storyStrength:4,evidence:'Saved transcript'})}}]});
    throw new Error('Unexpected external request: '+url);
  };
  const app={use(){},get(path,fn){routes.set(path,fn)},post(path,fn){routes.set(path,fn)},listen(){}};
  const express=Object.assign(()=>app,{json:()=>()=>{}});
  const context=vm.createContext({createV9Controller:()=>({}),express,fetch,process:{env:{SUPABASE_URL:'https://db.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture',RAILWAY_GIT_COMMIT_SHA:'test-sha'},on(){}},console,crypto:{randomUUID},promisify:()=>async()=>{throw new Error('Unexpected audio extraction')},execFile(){},Buffer,AbortSignal,setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},setImmediate:fn=>pending.push(fn)});
  // Run the real worker orchestration; only imports, server startup, external APIs
  // and image extraction are replaced. No production data or credentials are used.
  vm.runInContext(source.replace(/import \{createV9Controller\} from '[^']+';/,'').replace(/import(?:\{[^}]+\}| express )from"[^"]+";/g,''),context);
  vm.runInContext('extractFrame=async()=>Buffer.from("fixture-image")',context);
  return {context,job,chunks,requests,patches,trace,routes,fetch,pending,async drain(){while(pending.length)await pending.shift()()}};
}
const response=()=>({code:200,status(code){this.code=code;return this},json(body){this.body=body;return this}});

test('golden funnel evaluates all stages; empty, miss and unknown VOD remain meaningful',()=>{
  const {context:c}=harness();
  const funnel=c.goldenFunnel(vod,{input:[{peak_seconds:8040},{seconds:8379}],empty:[],miss:[{seconds:0}]});
  assert.equal(funnel.goldens.length,2);
  for(const golden of funnel.goldens){assert.equal(golden.stages.input.hit,true);assert.equal(golden.stages.empty.nearest,null);assert.equal(golden.stages.miss.hit,false)}
  assert.equal(c.goldenFunnel('unknown',{}),null);
  assert.throws(()=>c.evaluateGolden([],{seconds:1}),/goldens must be an array/);
});

test('failed replay runs to 100% through worker endpoint without transcription or checkpoint writes',async()=>{
  const h=harness(),before=JSON.stringify(h.chunks),res=response();
  await h.routes.get('/jobs/replay-v82')({body:{id}},res);
  assert.equal(res.code,202);assert.equal(res.body.resumed,true);
  await h.drain();
  assert.equal(h.job.status,'completed');assert.equal(h.job.progress,100);assert.equal(h.job.error,null);
  assert.equal(h.job.result.benchmark.top10Hits,2);
  assert.equal(h.job.result.goldenFunnel.goldens[0].stages.top10.hit,true);
  assert.equal(h.job.result.checkpoint.preserve,true);assert.equal(h.job.result.replayPending,false);
  assert.equal(JSON.stringify(h.chunks),before);
  assert.deepEqual([...new Set(h.trace.map(t=>t.stage))],['persisted_v81_input','v82_renormalized','understood','pre_ranked','vision','global_ranked','pairwise_final']);
  assert.ok(h.patches.filter(p=>p.stage).every(p=>/^V8\.[23]/.test(p.stage)));
  assert.ok(h.patches.filter(p=>p.algo_version).every(p=>['V8.2','V8.3'].includes(p.algo_version)));
  assert.equal(h.job.algo_version,'V8.3');
  assert.ok(!h.requests.some(r=>/transcriptions/.test(r.url)));
});

test('generic resume and automatic recovery retain replay routing',async()=>{
  for(const mode of ['manual','recovery']){
    const h=harness(mode==='recovery'?{status:'ranking',stage:'V8.1 • old visual stage',error:null,result:{replayPending:true}}:{});
    if(mode==='manual'){await h.routes.get('/jobs/resume')({body:{id}},response());await h.drain()}
    else await h.context.recoverStaleJobs();
    assert.equal(h.job.status,'completed');assert.equal(h.job.result.replayPending,false);
    assert.ok(!h.requests.some(r=>r.url.includes('/vod_chunks')&&r.method!=='GET'));
  }
});

test('recovery failure preserves progress and replay identity',async()=>{
  const h=harness({status:'ranking',result:{replayPending:true}});
  vm.runInContext('replayV82=async()=>{throw new Error("fixture failure")}',h.context);
  await h.context.recoverStaleJobs();
  assert.equal(h.job.status,'failed');assert.equal(h.job.progress,97);
  assert.equal(h.job.stage,'V8.2 • replay falhou');assert.equal(h.job.result.replayPending,true);
});

test('Next PUT accepts failed replay, rejects unrelated failure, and reaches worker',async()=>{
  for(const replay of [true,false]){
    const h=harness(replay?{}:{stage:'V8.1 • falha',error:'unrelated'});
    const next=vm.createContext({publicJob,Response,AbortSignal,process:{env:{}},getJob:async()=>h.job,fetch:async(url,options)=>{assert.ok(url.endsWith('/jobs/replay-v82'));const res=response();await h.routes.get('/jobs/replay-v82')({body:JSON.parse(options.body)},res);return {ok:res.code<400,status:res.code,json:async()=>res.body}}});
    vm.runInContext(readFileSync(new URL('../app/api/jobs/[id]/route.js',import.meta.url),'utf8').replace(/^import[^;]+;/gm,'').replaceAll('export async function','async function'),next);
    const res=await next.PUT(null,{params:Promise.resolve({id})});
    assert.equal(res.status,replay?200:409);
    await h.drain();if(replay)assert.equal(h.job.status,'completed');
  }
});

test('health identifies deployed fix and commit',()=>{
  const h=harness(),res=response();h.routes.get('/health')(null,res);
  assert.equal(res.body.version,'V8.2-evidence-2');assert.equal(res.body.commit,'test-sha');
});

test('legacy replay cannot overwrite a result while V9 holds the shared reservation',async()=>{
  const h=harness({status:'completed',error:null}),before=JSON.stringify(h.job.result),res=response();
  const lock=await h.context.reserveJob(id);
  await h.routes.get('/jobs/replay-v82')({body:{id}},res);
  assert.equal(res.code,409);assert.equal(JSON.stringify(h.job.result),before);
  await lock.release();
});


test('frame arrays reach ranking and absent or failed vision stays unavailable',()=>{
 const {context:c}=harness();
 const visual=c.cardForRanking({visual_evidence:{frames:[{mediaOnScreen:true,reactionVisible:true,externalMediaType:'video_clip',description:'Vídeo na tela'},{mediaOnScreen:false,reactionVisible:true,description:'Reação'}]}},0).visualEvidence;
 assert.equal(visual.mediaOnScreen,true);assert.equal(visual.reactionVisible,true);assert.equal(visual.externalMediaType,'video_clip');assert.match(visual.description,/Vídeo/);
 assert.equal(c.cardForRanking({},0).visualEvidence.available,false);
 assert.equal(c.normalizeVisualEvidence({available:false,frames:[{mediaOnScreen:true}]}).available,false);
 assert.equal(c.normalizeVisualEvidence({mediaOnScreen:'false'}).available,false);
 assert.equal(c.normalizeVisualEvidence({mediaOnScreen:false,description:'Sem mídia'}).mediaOnScreen,false);
});

test('narrative quotes must occur in the claimed saved transcript segment',()=>{
 const {context:c}=harness(),chunks=[{transcript_segments:[{start_seconds:100,end_seconds:220,text:'Não fui eu. Mostra a prova. Aqui está o vídeo.'}]}];
 const out=c.groundedNarrative(chunks,{peak_seconds:200},[{startSeconds:100,quote:'Mostra a prova.'},{startSeconds:100,quote:'Inventado'},{startSeconds:101,quote:'Aqui está o vídeo.'}]);
 assert.equal(out.length,1);assert.equal(out[0].quote,'Mostra a prova.');assert.equal(out[0].endSeconds,220);
 assert.equal(c.groundedNarrative(chunks,{peak_seconds:2000},[{startSeconds:100,quote:'Mostra a prova.'}]).length,0);
});

test('global ranking receives bounded neighboring evidence and preserves a zero score',async()=>{
 const h=harness();let request;
 h.context.fetch=async(_url,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({order:[{id:0,score:0,reason:'Sem valor'},{id:1,score:50}]})}}]})}};
 const events=[{peak_seconds:200,arc_id:'a',score:80,clip_card:{narrativeEvidence:[{startSeconds:100,quote:'Mostra a prova.'}]}},{peak_seconds:300,arc_id:'b',summary:'Consequência'}];
 const result=await h.context.globalRerank(events);
 assert.equal(result[0].score,0);
 const prompt=request.messages[0].content,cards=JSON.parse(prompt.split('CANDIDATOS: ')[1]);
 assert.equal(cards[0].narrativeEvidence[0].quote,'Mostra a prova.');assert.equal(cards[0].nearbyContext[0].sameArc,false);assert.equal(cards[0].nearbyContext[0].peakSeconds,300);
 assert.equal(h.context.rankingContext(events[0],[events[0],{peak_seconds:5000}]).length,0);
});
