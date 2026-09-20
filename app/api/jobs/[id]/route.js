import{getJob}from"../../../../lib/jobs";
const WORKER=process.env.WORKER_URL||"https://clip-finder-worker-5xwo.onrender.com";
const WORKER_SECRET=process.env.WORKER_SECRET||"";
const ACTIVE=new Set(["queued","resolving","scanning","transcribing","ranking"]);
export async function GET(_req,{params}){try{const{id}=await params;const job=await getJob(id);if(!job)return Response.json({ok:false,error:"Análise não encontrada."},{status:404});if(ACTIVE.has(job.status)){fetch(WORKER+"/jobs/recover",{method:"POST",headers:{Authorization:"Bearer "+WORKER_SECRET,"Content-Type":"application/json"},body:"{}",signal:AbortSignal.timeout(8000)}).catch(()=>{})}return Response.json({ok:true,job})}catch(e){return Response.json({ok:false,error:e.message},{status:500})}}