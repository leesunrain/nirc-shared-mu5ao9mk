export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({ok:false,error:'POST만 지원합니다.'});
  try{
    const body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};const {provider,token}=body;
    // detect는 githubToken/vercelToken을 별도로 받으므로 공통 token 검사를 통과시킨다.
    if(provider!=='detect'&&!token)return res.status(400).json({ok:false,error:'토큰이 없습니다.'});
    if(provider==='github'){
      const r=await fetch('https://api.github.com/user',{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'}});const d=await r.json();if(!r.ok)return res.status(r.status).json({ok:false,error:d.message||'GitHub 연결 실패'});return res.json({ok:true,label:`${d.login} 연결됨`});
    }
    if(provider==='vercel'){
      const r=await fetch('https://api.vercel.com/v2/user',{headers:{Authorization:`Bearer ${token}`}});const d=await r.json();if(!r.ok)return res.status(r.status).json({ok:false,error:d?.error?.message||'Vercel 연결 실패'});return res.json({ok:true,label:`${d.user?.username||d.user?.name||'Vercel'} 연결됨`});
    }
    if(provider==='supabase'){
      const r=await fetch('https://api.supabase.com/v1/organizations',{headers:{Authorization:`Bearer ${token}`}});const d=await r.json();if(!r.ok)return res.status(r.status).json({ok:false,error:d?.message||'Supabase 연결 실패'});return res.json({ok:true,label:`${Array.isArray(d)?d.length:0}개 조직 확인`});
    }
    if(provider==='detect'){
      const {githubToken,vercelToken,repoName,zipName,appName}=body;
      if(!githubToken||!vercelToken||!repoName){
        return res.status(400).json({
          ok:false,
          error:'자동 확인에 필요한 정보가 없습니다.',
          githubError:githubToken?'':'GitHub 토큰 없음',
          vercelError:vercelToken?'':'Vercel 토큰 없음'
        });
      }

      const signature=(v)=>{
        let s=String(v||'').toLowerCase().replace(/\.zip$/,'');
        s=s.replace(/-\d+$/,'');
        s=s.replace(/(?:[-_. ]?v?\d+(?:[._-]\d+)*)$/,'');
        s=s.replace(/[^a-z0-9]/g,'');
        return s;
      };
      const transient=/^nircapp\d{6,14}$/i;
      const wanted=new Set([signature(repoName),signature(zipName),signature(appName)].filter(x=>x&&!transient.test(x)));

      let githubRepos=[],vercelProjects=[];
      let githubError='',vercelError='',githubStatus='',vercelStatus='';

      try{
        const gr=await fetch('https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator&sort=updated',{
          headers:{
            Authorization:`Bearer ${githubToken}`,
            Accept:'application/vnd.github+json',
            'X-GitHub-Api-Version':'2022-11-28'
          }
        });
        githubStatus=`HTTP ${gr.status}`;
        const raw=await gr.text();
        let gd;
        try{ gd=raw?JSON.parse(raw):[] }catch{ gd=raw }
        if(!gr.ok){
          const msg=typeof gd==='object'?(gd?.message||JSON.stringify(gd)):String(gd||'');
          throw new Error(`${githubStatus} ${msg}`.trim());
        }
        githubRepos=Array.isArray(gd)?gd.map(x=>String(x.name||'')):[];
      }catch(e){
        githubError=e?.message||String(e);
        if(!githubStatus)githubStatus='요청 실패';
      }

      try{
        const vr=await fetch('https://api.vercel.com/v9/projects?limit=100',{
          headers:{Authorization:`Bearer ${vercelToken}`}
        });
        vercelStatus=`HTTP ${vr.status}`;
        const raw=await vr.text();
        let vd;
        try{ vd=raw?JSON.parse(raw):{} }catch{ vd=raw }
        if(!vr.ok){
          const msg=typeof vd==='object'?(vd?.error?.message||vd?.message||JSON.stringify(vd)):String(vd||'');
          throw new Error(`${vercelStatus} ${msg}`.trim());
        }
        vercelProjects=Array.isArray(vd.projects)?vd.projects.map(x=>String(x.name||'')):[];
      }catch(e){
        vercelError=e?.message||String(e);
        if(!vercelStatus)vercelStatus='요청 실패';
      }

      if(githubError||vercelError){
        return res.status(200).json({
          ok:false,
          error:'GitHub/Vercel 실제 목록 확인 실패',
          githubStatus,
          vercelStatus,
          githubError,
          vercelError
        });
      }

      const exactName=String(repoName||'').toLowerCase();
      const ghExact=githubRepos.find(n=>n.toLowerCase()===exactName)||'';
      const vcExact=vercelProjects.find(n=>n.toLowerCase()===exactName)||'';

      let resolvedName='';
      let matchType='';

      if(ghExact&&vcExact){
        resolvedName=ghExact;
        matchType='이름 정확히 일치';
      }else{
        const ghMatches=githubRepos.filter(n=>wanted.has(signature(n)));
        const vcMatches=vercelProjects.filter(n=>wanted.has(signature(n)));
        const common=ghMatches.filter(g=>vcMatches.some(v=>v.toLowerCase()===g.toLowerCase()));
        const uniq=[...new Set(common.map(x=>x.toLowerCase()))];
        if(uniq.length===1){
          resolvedName=common[0];
          matchType='앱 이름 자동 매칭';
        }
      }

      if(resolvedName){
        const lower=resolvedName.toLowerCase();
        return res.json({
          ok:true,
          resolvedName,
          matchType,
          githubExists:githubRepos.some(n=>n.toLowerCase()===lower),
          vercelExists:vercelProjects.some(n=>n.toLowerCase()===lower),
          githubStatus,
          vercelStatus
        });
      }

      const ghCandidate=githubRepos.some(n=>n.toLowerCase()===exactName);
      const vcCandidate=vercelProjects.some(n=>n.toLowerCase()===exactName);

      return res.json({
        ok:true,
        resolvedName:repoName,
        matchType:(ghCandidate||vcCandidate)?'한쪽만 일치':'새 앱 이름',
        githubExists:ghCandidate,
        vercelExists:vcCandidate,
        githubStatus,
        vercelStatus
      });
    }
    return res.status(400).json({ok:false,error:'지원하지 않는 서비스입니다.'});
  }catch{return res.status(500).json({ok:false,error:'연결 확인 중 오류가 발생했습니다.'})}
}
