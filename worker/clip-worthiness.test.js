import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AXES,RUBRIC,judgeInput,validateJudgment,groundJudgment,rerank,acceptance,callJudge} from './clip-worthiness.js';
import {loadSnapshot,runExperiment,main} from './replay-v9.js';

const id = '11111111-1111-1111-1111-111111111111';
function fixture(count=12) {
  const candidates = Array.from({length:count},(_,i)=>({key:'c'+i,oldRank:i+1,oldScore:100-i,
    peak_seconds:i*100+20,start_seconds:i*100,end_seconds:i*100+60,summary:'Evento '+i}));
  const chunks = candidates.map(c=>({start_seconds:c.start_seconds,end_seconds:c.end_seconds,
    transcript_segments:[{start_seconds:c.start_seconds,end_seconds:c.start_seconds+3,text:'Por que isso aconteceu?'},
      {start_seconds:c.start_seconds+3,end_seconds:c.end_seconds,text:'A prova está aqui. Resolvido.'}]}));
  return {source:{kind:'pairwise_final'},baselineTop10:candidates.slice(0,10),candidates,chunks};
}
function verdict(input,{score=3,eventValue=4,decision='Postaria'}={}) {
  const axis = score=>({score,reason:'A pergunta sobre a prova cria expectativa e a resposta a resolve.',
    evidence:[{sourceId:input.segments[0].sourceId,quote:input.segments[0].text}]});
  return {eventValue:axis(eventValue),...Object.fromEntries(AXES.map(k=>[k,axis(score)])),contextDependence:axis(0),
    decision,publishReason:'A pergunta concreta é respondida no próprio trecho.',missingContext:'',uncertainty:''};
}
const provider = async input=>({judgment:verdict(input),usage:{total_tokens:100}});

test('same frozen pool is reranked on cold worthiness, independently of event value/old score',async()=>{
  const snapshot = fixture(), before = JSON.stringify(snapshot);
  const ranked = await rerank(snapshot,{judge:async input=>({judgment:verdict(input,
    input.startSeconds === 1100 ? {score:4,eventValue:1} : {score:1,eventValue:4,decision:'Não postaria'})})});
  assert.equal(ranked[0].key,'c11');assert.equal(ranked[0].rankChange,11);
  assert.equal(ranked[0].diagnostics.eventValue.score,1);
  assert.equal(ranked.length,12);assert.equal(JSON.stringify(snapshot),before);
  assert.deepEqual(new Set(ranked.map(c=>c.key)),new Set(snapshot.candidates.map(c=>c.key)));
});

test('coarse segment overlap cannot establish the opening; unknown stays null',async()=>{
  const snapshot = fixture(1);snapshot.chunks[0].transcript_segments = [{start_seconds:0,end_seconds:120,text:'Pergunta e resposta'}];
  const input = judgeInput(snapshot.candidates[0],snapshot.chunks);
  assert.equal(input.segments[0].overlapOnly,true);assert.equal(input.segments[0].openingVerified,false);
  assert.throws(()=>validateJudgment(verdict(input),input),/primeiros 3s/);
  const value = verdict(input,{decision:'Talvez'});value.coldHook = {score:null,reason:'Timestamp insuficiente',evidence:[]};
  assert.equal(validateJudgment(value,input).coldHook.score,null);
  const ranked = await rerank(snapshot,{judge:async()=>({judgment:value})});
  assert.equal(ranked[0].evaluatedAxes,4);assert.equal(ranked[0].clipWorthiness,75);
});

test('rejects hallucinations, bad scores, missing reasons, unsupported publish decision and malformed JSON',async()=>{
  const snapshot = fixture(1), input = judgeInput(snapshot.candidates[0],snapshot.chunks);
  for (const mutate of [v=>v.standalone.score=5,v=>v.standalone.score='3',v=>v.standalone.reason='',
    v=>v.standalone.evidence[0].quote='Inventado',v=>v.standalone.evidence=[],v=>v.contextDependence.score=4,
    v=>v.coldHook.score=null,v=>v.decision='sim']) {
    const v = verdict(input);mutate(v);assert.throws(()=>validateJudgment(v,input));
  }
  const invalid=await callJudge(input,{model:'fixture',apiKey:'fixture',fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:'bad JSON'}}]})})});
  assert.equal(invalid.unavailable.reason,'INVALID_JUDGE_RESPONSE');assert.equal(invalid.judgment,undefined);
});

test('judge input excludes old rankings, scores, participant lists and ranking reasons',async()=>{
  const snapshot = fixture(1);Object.assign(snapshot.candidates[0],{participants:['Famous'],clip_card:{eventValue:4},oldReason:'Publicar sempre'});
  snapshot.candidates[0].visual_evidence={frames:[{description:'A pessoa mostra uma prova na tela.'}]};
  const input = judgeInput(snapshot.candidates[0],snapshot.chunks);
  assert.equal(input.savedVisualEvidence.descriptions[0],'A pessoa mostra uma prova na tela.');
  assert.ok(!JSON.stringify(input).includes('Publicar sempre'));assert.ok(!JSON.stringify(input).includes('Famous'));
  let request;
  await callJudge(input,{model:'fixture',apiKey:'fixture',fetchImpl:async(url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/chat/completions');request = JSON.parse(options.body);
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(verdict(input))}}]})};
  }});
  assert.equal(request.messages[0].role,'system');assert.equal(request.messages[0].content,RUBRIC);
  assert.equal(request.messages[1].content,'DADOS: '+JSON.stringify(input));
});

test('unsupported features become unknown, never fabricated quotes or negative editorial judgments',()=>{
  const snapshot=fixture(1),input=judgeInput(snapshot.candidates[0],snapshot.chunks);
  for(const decision of ['Postaria','Não postaria','Talvez']) {
    const raw=verdict(input,{decision});raw.contextDependence.evidence=[];
    raw.standalone.evidence[0].quote='Texto que nunca foi dito';
    const before=JSON.stringify(raw),result=groundJudgment(raw,input);
    assert.equal(result.judgment.contextDependence.score,null);assert.equal(result.judgment.standalone.score,null);
    assert.deepEqual(result.judgment.standalone.evidence,[]);assert.equal(result.judgment.decision,'Talvez');
    assert.equal(result.judgment.curiosityGap.score,3);assert.equal(JSON.stringify(raw),before);
    assert.ok(result.warnings.some(w=>w.axis==='contextDependence'&&w.reason==='score_without_evidence'));
    assert.doesNotThrow(()=>validateJudgment(result.judgment,input));
  }
});

test('coarse hook timing and unsupported publish decision are conservative; valid response stays identical',()=>{
  const snapshot=fixture(1),input=judgeInput(snapshot.candidates[0],snapshot.chunks);
  const raw=verdict(input);
  assert.deepEqual(groundJudgment(raw,input),{judgment:validateJudgment(raw,input),warnings:[]});
  input.segments[0].openingVerified=false;
  const result=groundJudgment(raw,input);
  assert.equal(result.judgment.coldHook.score,null);assert.equal(result.judgment.decision,'Talvez');
  assert.ok(result.warnings.some(w=>w.reason==='opening_timing_unknown'));
  assert.throws(()=>groundJudgment({},input),/inválida/);
  raw.standalone.score=7;assert.throws(()=>groundJudgment(raw,input),/Eixo V9 inválido/);
});

test('actual model adapter preserves raw unsupported response and cache replay costs zero',async()=>{
  const snapshot=fixture(1),cache={};let calls=0;
  const judge=async input=>callJudge(input,{model:'fixture',apiKey:'fixture',fetchImpl:async()=>{
    calls++;const raw=verdict(input);raw.standalone.evidence[0].quote='Não está na transcrição';
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(raw)}}],usage:{total_tokens:10}})};
  }});
  const result=await rerank(snapshot,{cache,judge});
  assert.equal(result.length,1);assert.equal(result[0].diagnostics.standalone.score,null);
  assert.ok(result[0].diagnostics.validationWarnings.length);
  assert.equal(Object.values(cache)[0].rawJudgment.standalone.evidence[0].quote,'Não está na transcrição');
  assert.deepEqual(await rerank(snapshot,{cache,judge}),result);assert.equal(calls,1);
});

test('all model content failures are cached as unavailable without blocking the next candidate',async()=>{
  const snapshot=fixture(8);let calls=0;
  const judge=async input=>callJudge(input,{model:'fixture',apiKey:'fixture',fetchImpl:async()=>{
    const raw=verdict(input),index=Number(input.startSeconds)/100;calls++;
    if(index===1)raw.decision='Resposta inválida';
    if(index===2)delete raw.standalone;
    if(index===3)raw.contextDependence.score=9;
    if(index===4)raw.universality.evidence='invalid schema';
    const content=index===5?'broken JSON':index===6?'':JSON.stringify(raw);
    return {ok:true,json:async()=>({choices:[{message:{content}}],usage:{total_tokens:10}})};
  }});
  const first=await runExperiment(snapshot,{judge});
  assert.equal(first.status,'completed');assert.deepEqual(first.ranked.map(c=>c.key),['c0','c7']);
  assert.equal(first.coverage.unavailable.length,6);assert.equal(first.coverage.eligible,2);
  assert.equal(first.metrics.v9.acceptanceAt10,null);
  assert.ok(first.coverage.unavailable.every(c=>c.decision===null&&c.clipWorthiness===null));
  assert.equal(Object.keys(first.cache).length,8);assert.equal(calls,8);
  assert.ok(Object.values(first.cache).filter(c=>c.unavailable).every(c=>typeof c.rawResponse==='string'));
  const again=await runExperiment(snapshot,{cache:first.cache,judge});
  assert.equal(calls,8);assert.deepEqual(again.coverage,first.coverage);assert.deepEqual(again.ranked,first.ranked);
});

test('transport and HTTP errors still stop without inventing unavailable model output',async()=>{
  const snapshot=fixture(1),input=judgeInput(snapshot.candidates[0],snapshot.chunks);
  await assert.rejects(callJudge(input,{model:'fixture',apiKey:'fixture',fetchImpl:async()=>({ok:false,status:429})}),/HTTP 429/);
  await assert.rejects(callJudge(input,{model:'fixture',apiKey:'fixture',fetchImpl:async()=>{throw new Error('network')}}),/network/);
});

test('failure preserves successful cache, resume spends only remaining calls, model/input changes invalidate cache',async()=>{
  const snapshot = fixture(3),cache = {};let calls=0,last;
  await assert.rejects(runExperiment(snapshot,{cache,save:async s=>{last=structuredClone(s)},judge:async input=>{
    if (++calls === 2) throw new Error('fixture failure');return provider(input);
  }}),/fixture failure/);
  assert.equal(last.status,'failed');assert.equal(last.ranked,undefined);assert.equal(Object.keys(last.cache).length,1);
  calls=0;
  const result = await runExperiment(snapshot,{cache:last.cache,judge:async input=>{calls++;return provider(input)}});
  assert.equal(calls,2);assert.equal(result.status,'completed');
  await rerank(snapshot,{cache:result.cache,judge:async()=>{throw new Error('should be cached')}});
  calls=0;await rerank(snapshot,{cache:result.cache,model:'another-model',judge:async input=>{calls++;return provider(input)}});
  assert.equal(calls,3);
  snapshot.candidates[0].summary='Outra hipótese';calls=0;
  await rerank(snapshot,{cache:result.cache,judge:async input=>{calls++;return provider(input)}});assert.equal(calls,1);
});

test('missing transcript is explicit; duplicate IDs and invalid bounds still fail before model spend',async()=>{
  const missing = fixture(2);missing.chunks=[];
  let coverage;
  assert.deepEqual(await rerank(missing,{judge:async()=>{assert.fail('no calls')},onCoverage:async value=>{coverage=value}}),[]);
  assert.equal(coverage.unavailable.length,2);assert.equal(coverage.eligible,0);
  const invalid=fixture(2);invalid.candidates[1].end_seconds=-1;
  await assert.rejects(rerank(invalid,{judge:async()=>{assert.fail('no calls')}}),/Limites/);
  const duplicate = fixture(2);duplicate.candidates[1].key='c0';
  await assert.rejects(rerank(duplicate,{judge:async()=>{assert.fail('no calls')}}),/duplicados/);
});

test('missing interval in Top60 no longer aborts replay, has no score and preserves old Top10/cache',async()=>{
  const snapshot=fixture(60);
  Object.assign(snapshot.candidates[0],{key:'14400|arc-116|frustração exagerada',start_seconds:14400,end_seconds:14460,peak_seconds:14400});
  const before=JSON.stringify(snapshot);let calls=0;
  const result=await runExperiment(snapshot,{judge:async input=>{calls++;return provider(input)}});
  assert.equal(result.status,'completed');assert.equal(calls,59);assert.equal(result.ranked.length,59);
  assert.equal(result.coverage.total,60);assert.equal(result.coverage.eligible,59);
  assert.equal(result.coverage.unavailable[0].key,snapshot.candidates[0].key);
  assert.equal(result.coverage.unavailable[0].decision,null);assert.equal(result.coverage.unavailable[0].clipWorthiness,null);
  assert.equal(result.coverage.unavailable[0].details.savedTextEnd,5960);
  assert.ok(result.review.some(r=>r.key===snapshot.candidates[0].key),'old Top10 still manually reviewable');
  assert.equal(JSON.stringify(snapshot),before);
  const repeated=await runExperiment(snapshot,{cache:result.cache,judge:async()=>{assert.fail('must use cache')}});
  assert.deepEqual(repeated.ranked,result.ranked);assert.deepEqual(repeated.coverage,result.coverage);
});

test('all missing text completes with explicit zero coverage and no fabricated V9 Top10',async()=>{
  const snapshot=fixture(10);snapshot.chunks=[];
  const result=await runExperiment(snapshot,{judge:async()=>{assert.fail('no model spend')}});
  assert.equal(result.status,'completed');assert.equal(result.ranked.length,0);assert.equal(result.coverage.unavailable.length,10);
  assert.equal(result.metrics.v9.size,0);assert.equal(result.metrics.v9.acceptanceAt10,null);
  assert.equal(result.review.length,10);assert.equal(Object.keys(result.cache).length,0);
});

function database({legacy=false,mismatch=false,changed=false}={}) {
  const snapshot=fixture(), requests=[];
  const top=snapshot.baselineTop10.map(c=>({seconds:c.peak_seconds,startSeconds:c.start_seconds,endSeconds:c.end_seconds,summary:c.summary,score:c.oldScore}));
  const job={id,status:'completed',algo_version:legacy?'V8.1':'V8.3',updated_at:'2026-09-23',result:{candidates:top,...(!legacy && {replayRunId:'v83-fixture'})}};
  let jobReads=0;
  return {requests,fetchImpl:async(raw,options)=>{
    assert.equal(options.method,'GET','database must be read-only');
    const url = new URL(raw);requests.push(url);
    let rows;
    if (url.pathname.endsWith('/analysis_jobs')) {jobReads++;rows=[{...job,result:changed&&jobReads>1?{...job.result,replayRunId:'changed'}:job.result}];}
    else if (url.pathname.endsWith('/vod_chunks')) rows=snapshot.chunks;
    else if (url.pathname.endsWith('/candidate_trace')) {
      assert.equal(url.searchParams.get('stage'),'eq.pairwise_final');assert.equal(url.searchParams.get('run_id'),'eq.v83-fixture');
      rows=snapshot.candidates.map(c=>({candidate_key:c.key,rank:c.oldRank,score:c.oldScore,peak_seconds:c.peak_seconds,
        payload:{start_seconds:c.start_seconds,end_seconds:mismatch?99999:c.end_seconds,summary:c.summary}}));
    } else assert.fail('Unexpected endpoint '+url.pathname);
    return {ok:true,json:async()=>structuredClone(rows)};
  }};
}

test('V8.3 snapshot reads exact pairwise pool; no media/transcription/discovery writes',async()=>{
  const db=database();const snapshot=await loadSnapshot(id,{url:'https://db.invalid',key:'fixture',fetchImpl:db.fetchImpl});
  assert.equal(snapshot.candidates.length,12);assert.equal(snapshot.source.kind,'pairwise_final');
  assert.deepEqual(snapshot.baselineTop10.map(c=>c.key),fixture().baselineTop10.map(c=>c.key));
  const result = await runExperiment(snapshot,{judge:provider});assert.equal(result.ranked.length,12);
  assert.equal(db.requests.length,4);
  assert.equal(result.metrics.v9.acceptanceAt10,null);
});

test('missing/mismatched trace and concurrent changes are refused, never silently replace baseline',async()=>{
  for (const options of [{mismatch:true},{changed:true}]) {
    const db=database(options);
    await assert.rejects(loadSnapshot(id,{url:'https://db.invalid',key:'fixture',fetchImpl:db.fetchImpl}),/corresponde|mudou/);
  }
  const db=database();
  await assert.rejects(loadSnapshot(id,{url:'https://db.invalid',key:'fixture',fetchImpl:async(url,options)=>
    url.includes('candidate_trace')?{ok:true,json:async()=>[]}:db.fetchImpl(url,options)}),/ausente/);
});

test('legacy V8 comparison is explicitly limited to saved Top10 without fabricated reserve ranking',async()=>{
  const db=database({legacy:true});const snapshot=await loadSnapshot(id,{url:'https://db.invalid',key:'fixture',fetchImpl:db.fetchImpl});
  assert.equal(snapshot.candidates.length,10);assert.equal(snapshot.source.kind,'saved_top10_only');
  assert.ok(!db.requests.some(r=>r.pathname.endsWith('/candidate_trace')));
});

test('full Top60 costs 60 judgments once, replay costs zero and candidate 61 is refused',async()=>{
  const snapshot=fixture(60),cache={};let calls=0;
  const judge=async input=>{calls++;return provider(input)};
  const first=await rerank(snapshot,{cache,judge});
  assert.equal(first.length,60);assert.equal(calls,60);
  assert.deepEqual(await rerank(snapshot,{cache,judge}),first);assert.equal(calls,60);
  await assert.rejects(rerank(fixture(61),{judge}),/1\.\.60/);assert.equal(calls,60);
});

test('manual Acceptance@10 needs all ten labels, counts only Postaria, and shares labels across rankings',async()=>{
  const snapshot=fixture(),ranked=await rerank(snapshot,{judge:provider});
  const labels=snapshot.candidates.map((c,i)=>({key:c.key,label:i<5?'Postaria':i<8?'Talvez':'Não postaria'}));
  let metrics=acceptance(snapshot,ranked,labels);
  assert.equal(metrics.baseline.acceptanceAt10,.5);assert.equal(metrics.v9.acceptanceAt10,.5);
  labels[0].label=null;metrics=acceptance(snapshot,ranked,labels);assert.equal(metrics.v9.acceptanceAt10,null);
  assert.throws(()=>acceptance(snapshot,ranked,[...labels,labels[0]]),/duplicada/);
  const small=fixture(2), smallRank=await rerank(small,{judge:provider});
  metrics=acceptance(small,smallRank,small.candidates.map(c=>({key:c.key,label:'Postaria'})));
  assert.equal(metrics.v9.acceptanceAt10,null);assert.equal(metrics.v9.acceptanceAtK,1);
});

test('CLI cached replay and manual metrics run offline; snapshot corruption is rejected',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'clip-v9-'));
  try {
    const snapshot=fixture(10), result=await runExperiment(snapshot,{judge:provider});
    const input=join(dir,'result.json'),labels=join(dir,'labels.json'),report=join(dir,'metrics.json');
    await writeFile(input,JSON.stringify(result));
    await main(['--input',input,'--review-out',labels]);
    const review=JSON.parse(await readFile(labels,'utf8'));assert.equal(review.length,10);
    await writeFile(labels,JSON.stringify(review.map(r=>({...r,label:'Postaria'}))));
    await assert.rejects(main(['--input',input,'--review-out',labels]),/Arquivo já existe/);
    assert.equal(JSON.parse(await readFile(labels,'utf8'))[0].label,'Postaria');
    await main(['--report',input,'--labels',labels,'--out',report]);
    assert.equal(JSON.parse(await readFile(report,'utf8')).metrics.v9.acceptanceAt10,1);
    result.snapshot.candidates[0].summary='tampered';await writeFile(input,JSON.stringify(result));
    await assert.rejects(main(['--input',input]),/Snapshot alterado/);
  } finally {await rm(dir,{recursive:true,force:true})}
});
