const KICK_HOSTS=new Set(["kick.com","www.kick.com"]);
function parseVod(raw){try{const u=new URL(raw);if(!KICK_HOSTS.has(u.hostname))return null;const m=u.pathname.match(/^\/([^/]+)\/videos\/([0-9a-fA-F-]{36})\/?$/);if(!m)return null;return{creator:m[1],videoId:m[2],url:u.toString()}}catch{return null}}
function pick(obj,keys){for(const k of keys){if(obj?.[k]!=null)return obj[k]}return null}
export async function POST(req){
 const body=await req.json().catch(()=>({}));const vod=parseVod(body.url||"");
 if(!vod)return Response.json({ok:false,error:"Cole um link válido de VOD da Kick."},{status:400});
 try{
  const r=await fetch(`https://kick.com/api/v1/video/${vod.videoId}`,{headers:{Accept:"application/json","User-Agent":"Mozilla/5.0"},cache:"no-store"});
  if(!r.ok)throw new Error("Kick não liberou os dados deste VOD.");
  const d=await r.json();
  const source=pick(d,["source","playback_url","url"])||pick(d?.video,["source","playback_url","url"]);
  const meta={title:pick(d,["livestream_title","session_title","title"])||pick(d?.livestream,["session_title","title"]),createdAt:pick(d,["created_at","start_time"]),duration:pick(d,["duration","duration_ms"]),views:pick(d,["views","view_count"]),thumbnail:pick(d,["thumbnail","thumbnail_url"])};
  return Response.json({ok:true,vod,meta,sourceAvailable:Boolean(source),status:source?"ready":"metadata-only",message:source?"VOD acessível. Fonte de mídia encontrada; pronto para gerar sinais de momentos.":"Metadados encontrados, mas a fonte de mídia não foi exposta."});
 }catch(e){return Response.json({ok:false,error:e.message||"Não foi possível consultar o VOD."},{status:502})}
}