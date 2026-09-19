export const maxDuration=300;
export async function POST(req){
 const body=await req.json().catch(()=>({}));const audioUrl=body.audioUrl;
 if(!audioUrl)return Response.json({ok:false,error:"Trecho de áudio ausente."},{status:400});
 if(!process.env.OPENAI_API_KEY)return Response.json({ok:false,error:"OPENAI_API_KEY ainda não configurada."},{status:503});
 try{
  const r=await fetch(audioUrl);if(!r.ok)throw new Error("Não foi possível baixar o trecho.");
  const blob=await r.blob();const form=new FormData();
  form.append("file",new File([blob],"clip.ts",{type:blob.type||"video/mp2t"}));
  form.append("model","gpt-transcribe");
  form.append("prompt","Live brasileira de games e entretenimento. Preserve nomes próprios, gírias, reações, discussões e piadas.");
  const tr=await fetch("https://api.openai.com/v1/audio/transcriptions",{method:"POST",headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},body:form});
  const data=await tr.json();if(!tr.ok){const msg=typeof data?.error?.message==="string"?data.error.message:typeof data?.error==="string"?data.error:JSON.stringify(data?.error||data);throw new Error(msg||"Falha na transcrição.");}
  return Response.json({ok:true,text:data.text||""});
 }catch(e){return Response.json({ok:false,error:e.message||"Falha na transcrição."},{status:502})}
}