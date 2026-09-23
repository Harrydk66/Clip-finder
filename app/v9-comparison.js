"use client";
import {useState} from 'react';

const labels=['Postaria','Talvez','Não postaria'];
const axes={eventValue:'Valor do acontecimento',standalone:'Compreensão sem contexto',coldHook:'Gancho inicial',
  curiosityGap:'Curiosidade',universality:'Interesse para desconhecidos',completionPayoff:'Conclusão / payoff',contextDependence:'Dependência de contexto'};
const time=s=>new Date(Math.max(0,Number(s)||0)*1000).toISOString().slice(11,19);
const metric=m=>m?.acceptanceAt10 == null ? 'Aguardando avaliação completa' : `${Math.round(m.acceptanceAt10*100)}% (${m.counts.Postaria}/10)`;

export default function V9Comparison({job,onRefresh}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const saved=job.result?.v9;
  const v9=saved?.baselineRunId===job.result?.replayRunId ? saved : null;
  const running=['queued','running'].includes(v9?.status);
  const recentlyUpdated=running && Date.now()-Date.parse(v9.updatedAt)<120000;
  async function request(method,body) {
    setBusy(true);setError('');
    try {
      const r=await fetch(`/api/jobs/${job.id}/v9`,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body || {})});
      const data=await r.json();if(!r.ok)throw new Error(data.error || 'Não foi possível concluir a solicitação.');
      await onRefresh();
    } catch(e) {setError(e.message);} finally {setBusy(false);}
  }
  const ready=job.status==='completed' && !job.result?.replayPending && Boolean(job.result?.replayRunId);
  return <section className="steps v9" aria-labelledby="v9-title">
    <h2 id="v9-title">Comparar com V9</h2>
    <p>Quais trechos você publicaria para quem nunca viu esta live? Compare os dois Top 10 mantendo os mesmos cortes.</p>
    {!ready && <p>Conclua primeiro o replay V8.3 usando o botão de reprocessar acima.</p>}
    {v9?.status!=='completed' && <>
      <button type="button" disabled={!ready||busy||recentlyUpdated} onClick={()=>request('POST')}>
        {busy?'Solicitando…':running?(recentlyUpdated?'Comparação em andamento…':'Retomar comparação V9'):v9?.status==='failed'?'Retomar comparação V9':'Comparar com V9'}
      </button>
      <small>Reutiliza a transcrição salva. A primeira execução faz até 60 avaliações de IA; a retomada usa o cache.</small>
    </>}
    {running && <div role="status" aria-live="polite">
      {v9.total ? `Avaliados ${v9.done} de ${v9.total} trechos.` : 'Preparando os candidatos salvos…'}
      <p>Você pode sair da página e voltar depois.</p>
      {!recentlyUpdated && <p>Sem progresso recente. Use “Retomar comparação V9” para continuar com o cache.</p>}
    </div>}
    {v9?.status==='failed' && <p role="alert">A comparação parou: {v9.error} As avaliações já salvas serão reutilizadas.</p>}
    {error && <p role="alert">{error}</p>}
    {v9?.status==='completed' && <>
      <b>Comparação pronta — avalie os trechos</b>
      <p>Assista somente ao intervalo indicado, pensando em alguém que não conhece a live. Cada escolha é salva automaticamente.</p>
      {v9.vodUrl && <a href={v9.vodUrl} target="_blank" rel="noreferrer">Abrir a live para assistir</a>}
      <div className="v9-metrics" aria-live="polite">
        <span><strong>Top 10 anterior:</strong> {metric(v9.metrics?.baseline)}</span>
        <span><strong>Top 10 V9:</strong> {metric(v9.metrics?.v9)}</span>
        <small>Aceitação = “Postaria” ÷ 10. “Talvez” é contado separadamente.</small>
      </div>
      {v9.review.map((r,i)=><fieldset className="v9-review" key={r.key} disabled={busy}>
        <legend>Trecho {i+1} · {time(r.startSeconds)} → {time(r.endSeconds)}</legend>
        <div className="v9-labels">{labels.map(label=><button type="button" key={label} aria-pressed={r.label===label}
          onClick={()=>request('PATCH',{key:r.key,label,snapshotHash:v9.snapshotHash})}>{label}</button>)}</div>
        <small>{r.label ? `Salvo: ${r.label}` : 'Ainda não avaliado'}</small>
      </fieldset>)}
      <details><summary>Ver posições e justificativas do V9</summary>
        <p>Avalie antes de abrir as justificativas para evitar influência das notas da IA. O gancho fica “não verificável” quando os horários salvos não permitem avaliar os primeiros segundos.</p>
        {v9.ranked.slice(0,10).map(c=><article className="v9-candidate" key={c.key}>
          <b>V9 #{c.v9Rank} · antes #{c.oldRank} · {time(c.start_seconds)} → {time(c.end_seconds)}</b>
          <p>{c.summary}</p><p><strong>{c.diagnostics.decision}:</strong> {c.diagnostics.publishReason}</p>
          <dl>{Object.entries(axes).map(([key,label])=><div key={key}><dt>{label}: {c.diagnostics[key].score ?? 'não verificável'}</dt><dd>{c.diagnostics[key].reason}</dd></div>)}</dl>
          {c.diagnostics.uncertainty && <p>Incerteza: {c.diagnostics.uncertainty}</p>}
        </article>)}
      </details>
    </>}
  </section>;
}
