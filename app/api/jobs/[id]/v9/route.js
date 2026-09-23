const WORKER=process.env.WORKER_URL||'https://clip-finder-production.up.railway.app';
async function forward(req,params,action) {
  try {
    const {id}=await params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      return Response.json({error:'Análise inválida'},{status:400});
    const feedback=action==='feedback' ? await req.json() : {};
    const response=await fetch(WORKER+'/jobs/v9'+(action==='feedback'?'/feedback':''),{
      method:'POST',headers:{Authorization:'Bearer '+(process.env.WORKER_SECRET||''),'Content-Type':'application/json'},
      body:JSON.stringify({id,...(action==='feedback'?{key:feedback.key,label:feedback.label,snapshotHash:feedback.snapshotHash}:{})}),
      signal:AbortSignal.timeout(20000),cache:'no-store'});
    const body=await response.json().catch(()=>({error:'Worker indisponível ou ainda sem a atualização V9.'}));
    return Response.json(body,{status:response.status});
  } catch { return Response.json({error:'Não foi possível falar com o worker. Atualize a página e tente novamente.'},{status:502}); }
}
export async function POST(req,{params}) { return forward(req,params,'start'); }
export async function PATCH(req,{params}) { return forward(req,params,'feedback'); }
