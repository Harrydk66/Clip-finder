import {readFile,writeFile,rename,access,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {VERSION,RUBRIC,rerank,reviewTemplate,acceptance} from './clip-worthiness.js';

const digest = x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadSnapshot(id,{url,key,fetchImpl=fetch}) {
  if (!uuid.test(id)) throw new Error('ID de analysis_jobs inválido');
  if (!url || !key) throw new Error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY necessárias');
  async function read(table, query) {
    const out = [];
    for (let offset=0;;offset+=1000) {
      const endpoint = new URL('/rest/v1/'+table,url);
      endpoint.search = new URLSearchParams({...query,limit:'1000',offset:String(offset)}).toString();
      const response = await fetchImpl(endpoint.href,{method:'GET',headers:{apikey:key,Authorization:'Bearer '+key},signal:AbortSignal.timeout(30000)});
      if (!response.ok) throw new Error('Leitura '+table+' HTTP '+response.status);
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error('Resposta inválida: '+table);
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  }
  const jobQuery = {id:'eq.'+id,select:'id,status,algo_version,vod_url,result,updated_at'};
  const job = (await read('analysis_jobs',jobQuery))[0];
  if (!job || job.status !== 'completed' || job.result?.replayPending) throw new Error('V9 exige análise/replay concluído');
  const oldTop = job.result?.candidates;
  if (!Array.isArray(oldTop) || !oldTop.length) throw new Error('Ranking anterior ausente');
  const chunks = await read('vod_chunks',{job_id:'eq.'+id,select:'chunk_index,start_seconds,end_seconds,transcript,transcript_segments',order:'chunk_index.asc'});
  let candidates, source;
  if (job.result.replayRunId) {
    const rows = await read('candidate_trace',{job_id:'eq.'+id,run_id:'eq.'+job.result.replayRunId,stage:'eq.pairwise_final',select:'*',order:'rank.asc,id.asc'});
    if (!rows.length || rows.length > 60) throw new Error('Trace pairwise_final ausente ou pool acima de 60; não refaça discovery automaticamente');
    candidates = rows.map((r,i)=>{
      if (Number(r.rank) !== i+1 || !r.candidate_key) throw new Error('Trace com ranks incompletos/duplicados');
      return {...r.payload,key:r.candidate_key,peak_seconds:Number(r.peak_seconds),arc_id:r.arc_id,
        oldRank:i+1,oldScore:r.score,oldReason:r.payload?.rankReason || ''};
    });
    source = {kind:'pairwise_final',runId:job.result.replayRunId,poolSize:candidates.length};
  } else {
    // No reconstructed V8 ranking: only the actual saved final output is comparable.
    candidates = oldTop.slice(0,10).map((c,i)=>({key:'v8-'+digest([c.seconds,c.startSeconds,c.endSeconds,c.arcId]),
      peak_seconds:c.seconds,start_seconds:c.startSeconds,end_seconds:c.endSeconds,arc_id:c.arcId,
      summary:c.summary,visual_evidence:c.visualEvidence || {},oldRank:i+1,oldScore:c.score,oldReason:c.reason || ''}));
    source = {kind:'saved_top10_only',runId:null,poolSize:candidates.length};
  }
  if (new Set(candidates.map(c=>c.key)).size !== candidates.length) throw new Error('Trace contém identidades duplicadas');
  const baselineTop10 = candidates.slice(0,10);
  if (oldTop.length < baselineTop10.length || !baselineTop10.every((c,i)=>
      Number(c.peak_seconds) === Number(oldTop[i].seconds) &&
      Number(c.start_seconds) === Number(oldTop[i].startSeconds) && Number(c.end_seconds) === Number(oldTop[i].endSeconds) &&
      (c.arc_id || null) === (oldTop[i].arcId || null)))
    throw new Error('Trace não corresponde ao Top 10 salvo; comparação cancelada');
  const fresh = (await read('analysis_jobs',jobQuery))[0];
  // Lease heartbeats update updated_at without changing any replay input.
  if (!fresh || fresh.status !== 'completed' || fresh.algo_version !== job.algo_version || digest(fresh.result) !== digest(job.result))
    throw new Error('Job mudou durante a leitura; tente novamente após concluir');
  return {jobId:id,vodUrl:job.vod_url,title:job.result.title,source,baselineVersion:job.algo_version,
    baselineUpdatedAt:job.updated_at,baselineSavedTop10:oldTop,baselineTop10,candidates,chunks};
}

export async function runExperiment(snapshot,{model='gpt-4o-mini',cache={},save=async()=>{},judge,apiKey}={}) {
  const result = {version:VERSION,model,rubricHash:digest(RUBRIC),snapshotHash:digest(snapshot),snapshot,cache,
    status:'running',createdAt:new Date().toISOString(),rankingPolicy:'decision, mean of known cold axes, old rank; eventValue excluded',
    limitations:['Saved transcript and saved visual descriptions only; no new vision/audio.', 'Segment timestamps do not prove word-level hook timing.',
      'Unknown axes remain null; clipWorthiness is a partial-evidence score, not a probability.']};
  await save(result);
  try {
    result.ranked = await rerank(snapshot,{model,cache,judge,apiKey,onCheckpoint:async()=>save(result),
      onCoverage:async coverage=>{result.coverage=coverage;await save(result);}});
    result.review = reviewTemplate(snapshot,result.ranked);
    result.metrics = acceptance(snapshot,result.ranked,result.review);
    result.status = 'completed';
    result.completedAt = new Date().toISOString();
    await save(result);
    return result;
  } catch (error) {
    result.status = 'failed';result.error = error.message;
    await save(result);
    throw error;
  }
}

async function writeJSON(path,data) {
  await mkdir(dirname(resolve(path)),{recursive:true});
  const temporary = path+'.tmp';
  await writeFile(temporary,JSON.stringify(data,null,2)+'\n',{encoding:'utf8',mode:0o600});
  await rename(temporary,path);
}

async function requireNewFile(path) {
  try { await access(path); } catch (error) { if (error.code === 'ENOENT') return;throw error; }
  throw new Error('Arquivo já existe: '+path+'; use --input para retomar ou escolha outro nome');
}

export async function main(argv) {
  const options = {};
  for (let i=0;i<argv.length;i+=2) {
    if (!['--job','--input','--out','--model','--report','--labels','--review-out'].includes(argv[i]) || !argv[i+1] || options[argv[i]])
      throw new Error('Uso: --job ID --out arquivo.json | --input arquivo.json [--out novo.json] | --report arquivo.json --labels labels.json [--out metricas.json]');
    options[argv[i]] = argv[i+1];
  }
  const readJSON = async path=>JSON.parse(await readFile(path,'utf8'));
  const modeCount = ['--job','--input','--report'].filter(k=>options[k]).length;
  if (modeCount !== 1) throw new Error('Escolha exatamente um: --job, --input, --report');
  if (options['--review-out']) await requireNewFile(options['--review-out']);
  if (options['--report']) {
    if (!options['--labels']) throw new Error('--labels necessário');
    const report = await readJSON(options['--report']);
    if (report.status !== 'completed') throw new Error('Avaliação ainda incompleta');
    const labels = await readJSON(options['--labels']);
    const metrics = acceptance(report.snapshot,report.ranked,labels);
    if (options['--out']) {
      if ([options['--report'],options['--labels']].some(p=>resolve(p) === resolve(options['--out']))) throw new Error('Use outro arquivo para métricas');
      await requireNewFile(options['--out']);
      await writeJSON(options['--out'],{version:report.version,snapshotHash:report.snapshotHash,labels,metrics});
    }
    console.log(JSON.stringify(metrics,null,2));return;
  }
  if (options['--labels']) throw new Error('--labels só é aceito com --report');
  const out = options['--out'] || options['--input'];
  if (!out) throw new Error('--out necessário para novo replay');
  if (!options['--input'] || resolve(out) !== resolve(options['--input'])) await requireNewFile(out);
  let previous, snapshot;
  if (options['--input']) {
    previous = await readJSON(options['--input']);
    if (!previous.snapshot || previous.snapshotHash !== digest(previous.snapshot)) throw new Error('Snapshot alterado ou inválido');
    snapshot = previous.snapshot;
  } else {
    snapshot = await loadSnapshot(options['--job'],{url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SERVICE_ROLE_KEY});
  }
  if (options['--review-out'] && [out,options['--input']].filter(Boolean).some(p=>resolve(p) === resolve(options['--review-out'])))
    throw new Error('Use outro arquivo para labels');
  const model = options['--model'] || previous?.model || process.env.V9_JUDGE_MODEL || process.env.RANKING_MODEL || 'gpt-4o-mini';
  const result = await runExperiment(snapshot,{model,cache:previous?.cache || {},apiKey:process.env.OPENAI_API_KEY,
    save:state=>writeJSON(out,state)});
  if (options['--review-out']) await writeJSON(options['--review-out'],result.review);
  console.log('V9 concluída: '+result.ranked.length+' candidatos. Resultado: '+out);
  if (snapshot.source.kind === 'saved_top10_only') console.log('V8: comparação limitada ao Top 10 salvo; não promove reservas.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
