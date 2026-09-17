export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({ok:false,error:'POST만 지원합니다.'});
  try{const body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};const {token,deploymentId}=body;if(!token||!deploymentId)return res.status(400).json({ok:false,error:'필수 정보가 없습니다.'});
    const r=await fetch(`https://api.vercel.com/v13/deployments/${encodeURIComponent(deploymentId)}`,{headers:{Authorization:`Bearer ${token}`}});const d=await r.json();if(!r.ok)return res.status(r.status).json({ok:false,error:d?.error?.message||'상태 확인 실패'});
    return res.json({ok:true,state:d.readyState||d.state,url:d.url?`https://${d.url}`:'',alias:Array.isArray(d.alias)&&d.alias[0]?`https://${d.alias[0]}`:''});
  }catch{return res.status(500).json({ok:false,error:'상태 확인 중 오류가 발생했습니다.'})}
}
