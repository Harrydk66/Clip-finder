import {VERSION,acceptance} from './clip-worthiness.js';
import {loadSnapshot,runExperiment} from './replay-v9.js';

const validId = id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const fault = (message,status=409)=>Object.assign(new Error(message),{status});

// The reservation is shared with the legacy replay and held through every checkpoint.
export function createV9Controller({getJob,saveResult,reserve,env=process.env,
  snapshotLoader=loadSnapshot,experiment=runExperiment,defer=setImmediate,now=()=>new Date().toISOString()}) {
  async function start(id) {
    if (!validId(id)) throw fault('Análise inválida',400);
    const lock = await reserve(id);
    if (!lock) throw fault('Esta análise já está sendo processada. Aguarde ou tente novamente em alguns instantes.');
    let queued = false;
    try {
      const job = await getJob(id);
      if (!job) throw fault('Análise não encontrada',404);
      if (job.status !== 'completed' || job.result?.replayPending) throw fault('Conclua o replay anterior antes de comparar com V9.');
      if (!job.result?.replayRunId) throw fault('Execute primeiro o replay V8.3 para comparar a seleção de candidatos.');
      const previous = job.result.v9;
      const sameBaseline = previous?.baselineRunId === job.result.replayRunId;
      if (sameBaseline && previous.status === 'completed' && previous.version === VERSION)
        return {ok:true,id,cached:true};
      if (!env.OPENAI_API_KEY || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)
        throw fault('O worker precisa das credenciais de IA e banco já usadas na análise.',503);
      const model = sameBaseline && previous?.model || env.V9_JUDGE_MODEL || env.RANKING_MODEL || 'gpt-4o-mini';
      const baselineRunId = job.result.replayRunId;
      const history = [...(job.result.v9History || [])];
      if (previous && !sameBaseline) {
        const {cache,snapshot,...summary} = previous;
        history.push({...summary,baselineTop10:snapshot?.baselineTop10 || []});
      }
      let state = {...(sameBaseline ? previous : {}),version:VERSION,model,baselineRunId,
        status:'queued',error:null,updatedAt:now()};
      async function save(next) {
        lock.assertHeld();
        const current = await getJob(id);
        if (current?.status !== 'completed' || current.result?.replayRunId !== baselineRunId)
          throw fault('A análise mudou durante a comparação.');
        state = {...next,baselineRunId,updatedAt:now()};
        await saveResult(id,{...current.result,v9:state,v9History:history});
      }
      await save(state);
      queued = true;
      defer(async()=>{
        try {
          const snapshot = state.snapshot || await snapshotLoader(id,{url:env.SUPABASE_URL,key:env.SUPABASE_SERVICE_ROLE_KEY});
          await experiment(snapshot,{model,apiKey:env.OPENAI_API_KEY,cache:state.cache || {},save});
        } catch (error) {
          try { await save({...state,status:'failed',error:error.message}); } catch (saveError) { console.error('[V9 checkpoint]',saveError.message); }
        } finally { await lock.release(); }
      });
      return {ok:true,id,cached:false};
    } finally { if (!queued) await lock.release(); }
  }

  async function feedback(id,body) {
    if (!validId(id)) throw fault('Análise inválida',400);
    const lock = await reserve(id);
    if (!lock) throw fault('A comparação ainda está em andamento.');
    try {
      const job = await getJob(id), state = job?.result?.v9;
      if (!job) throw fault('Análise não encontrada',404);
      if (state?.status !== 'completed') throw fault('Conclua o V9 antes de avaliar.');
      if (state.baselineRunId !== job.result.replayRunId) throw fault('O ranking anterior mudou. Execute uma nova comparação V9.');
      if (body?.snapshotHash !== state.snapshotHash) throw fault('A comparação mudou. Atualize a página.');
      if (!state.review.some(r=>r.key === body.key)) throw fault('Trecho não pertence à avaliação.',400);
      const review = state.review.map(r=>r.key === body.key ? {...r,label:body.label} : r);
      let metrics;
      try { metrics = acceptance(state.snapshot,state.ranked,review); }
      catch { throw fault('Use Postaria, Talvez ou Não postaria.',400); }
      lock.assertHeld();
      await saveResult(id,{...job.result,v9:{...state,review,metrics,updatedAt:now()}});
      return {ok:true,review,metrics};
    } finally { await lock.release(); }
  }
  return {start,feedback};
}
