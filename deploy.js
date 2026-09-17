const GH_API='https://api.github.com';
const GH_HEADERS=token=>({Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','Content-Type':'application/json'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function gh(url,token,opt={}){const r=await fetch(url,{...opt,headers:{...GH_HEADERS(token),...(opt.headers||{})}});const text=await r.text();let d={};try{d=text?JSON.parse(text):{}}catch{d={message:text}}return{r,d}}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;async function worker(){while(true){const i=next++;if(i>=items.length)return;out[i]=await fn(items[i],i)}}await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out}
function validate(body){
  if(!body.githubToken||!body.vercelToken)throw new Error('GitHub/Vercel 토큰을 먼저 등록하세요.');
  if(!body.appName||!body.repoName)throw new Error('앱 이름과 저장소 이름이 필요합니다.');
  if(!/^[a-z0-9._-]{1,80}$/.test(body.repoName))throw new Error('GitHub/Vercel 이름은 영문 소문자, 숫자, 점, 밑줄, 하이픈만 사용하세요.');
  if(!Array.isArray(body.files)||!body.files.length)throw new Error('배포할 파일이 없습니다.');
  if(body.mode==='update'){
    if(!body.lockedRepoName)throw new Error('안전 차단: 기존 앱 업데이트는 먼저 기존 앱을 선택해 주소를 잠가야 합니다.');
    if(body.lockedRepoName!==body.repoName)throw new Error('안전 차단: 잠긴 기존 주소와 배포 대상이 다릅니다.');
  }
  if(body.files.length>220)throw new Error('첫 버전은 파일 220개 이하를 지원합니다.');
  const total=body.files.reduce((s,f)=>s+Number(f.size||0),0);if(total>2.6*1024*1024)throw new Error('첫 버전은 압축 해제 후 약 2.6MB 이하 앱을 지원합니다.');
  for(const f of body.files){if(!f.path||f.path.startsWith('/')||f.path.includes('..')||f.path.includes('\\'))throw new Error(`허용되지 않는 경로: ${f.path}`);if(!/^[A-Za-z0-9+/]*={0,2}$/.test(f.data||''))throw new Error(`잘못된 파일 데이터: ${f.path}`)}
}

function slugifyServer(v){
  return String(v||'').toLowerCase().replace(/\.zip$/i,'').replace(/[^a-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80);
}
function zipMatchesTargetServer(zipName,target){
  const z=slugifyServer(zipName), t=slugifyServer(target);
  return !!z && !!t && (z===t || z.startsWith(t+'-v') || z.startsWith(t+'.') || z.startsWith(t+'_v'));
}
function makeAppId(){return `oc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,12)}`}
async function getExistingManifest(owner,repoName,token){
  const r=await gh(`${GH_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/contents/.oneclick-app.json`,token);
  if(r.r.status===404)return null;
  if(!r.r.ok)throw new Error(`앱 안전정보 확인 실패: ${r.d.message||r.r.status}`);
  try{
    const raw=Buffer.from(String(r.d.content||'').replace(/\n/g,''),'base64').toString('utf8');
    return JSON.parse(raw);
  }catch{throw new Error('기존 앱의 안전정보가 손상되어 업데이트를 차단했습니다.')}
}

async function syncGithub(body){
  const token=body.githubToken;const user=await gh(`${GH_API}/user`,token);if(!user.r.ok)throw new Error(`GitHub 인증 실패: ${user.d.message||user.r.status}`);const owner=user.d.login;
  let repo=await gh(`${GH_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(body.repoName)}`,token);let created=false;
  // 기존 앱 빠른 선택으로 appId가 전달된 경우에는 ZIP 파일명보다 앱 고유 ID를 우선 검증한다.
  // appId가 없는 구버전 업데이트만 파일명 일치 규칙을 유지한다.
  if(body.mode==='update' && !body.expectedAppId && !zipMatchesTargetServer(body.zipName,body.repoName)){
    throw new Error(`안전 차단: 선택한 ZIP '${body.zipName||'없음'}'은 대상 앱 '${body.repoName}'용 파일이 아닙니다. 기존 앱 빠른 선택을 사용하면 파일명이 달라도 안전 업데이트할 수 있습니다.`);
  }
  if(repo.r.status===404){
    if(body.mode==='update')throw new Error(`안전 차단: 기존 GitHub 저장소 '${body.repoName}'가 없어 업데이트할 수 없습니다.`);
    repo=await gh(`${GH_API}/user/repos`,token,{method:'POST',body:JSON.stringify({name:body.repoName,description:'원클릭 앱 배포기로 관리되는 저장소',private:body.visibility!=='public',auto_init:true})});
    if(!repo.r.ok)throw new Error(`GitHub 저장소 생성 실패: ${repo.d.message||repo.r.status}`);
    created=true;await sleep(600);
  }else if(!repo.r.ok)throw new Error(`GitHub 저장소 확인 실패: ${repo.d.message||repo.r.status}`);
  else if(body.mode==='create')throw new Error(`안전 차단: GitHub 저장소 '${body.repoName}'가 이미 있습니다. 새 앱으로 덮어쓸 수 없습니다.`);

  let manifest=null;
  if(body.mode==='update'){
    manifest=await getExistingManifest(owner,body.repoName,token);
    if(manifest && body.expectedAppId && manifest.appId!==body.expectedAppId){
      throw new Error('안전 차단: 선택한 앱의 고유 ID가 대상 저장소와 일치하지 않습니다.');
    }
    if(manifest && manifest.repoName && manifest.repoName!==body.repoName){
      throw new Error('안전 차단: 저장소의 앱 안전정보와 대상 이름이 일치하지 않습니다.');
    }
  }
  const appId=(manifest&&manifest.appId)||body.expectedAppId||makeAppId();
  const safetyFile={path:'.oneclick-app.json',data:Buffer.from(JSON.stringify({appId,repoName:body.repoName,appName:body.appName,managedBy:'oneclick-deployer-v1.3-safe'},null,2)).toString('base64'),size:0};
  body.files=[...body.files.filter(f=>f.path!=='.oneclick-app.json'),safetyFile];
  const branch=repo.d.default_branch||'main';let ref=null;
  for(let i=0;i<5;i++){const rr=await gh(`${GH_API}/repos/${owner}/${body.repoName}/git/ref/heads/${encodeURIComponent(branch)}`,token);if(rr.r.ok){ref=rr.d;break}await sleep(500)}
  if(!ref)throw new Error('GitHub 기본 브랜치를 준비하지 못했습니다. 잠시 후 다시 시도하세요.');
  const parent=ref.object.sha;const commit=await gh(`${GH_API}/repos/${owner}/${body.repoName}/git/commits/${parent}`,token);if(!commit.r.ok)throw new Error('GitHub 현재 커밋을 읽지 못했습니다.');const baseTree=commit.d.tree.sha;
  const current=await gh(`${GH_API}/repos/${owner}/${body.repoName}/git/trees/${baseTree}?recursive=1`,token);const existing=new Set();if(current.r.ok&&Array.isArray(current.d.tree))for(const x of current.d.tree)if(x.type==='blob')existing.add(x.path);
  const paths=new Set(body.files.map(f=>f.path));
  const blobs=await mapLimit(body.files,6,async f=>{const br=await gh(`${GH_API}/repos/${owner}/${body.repoName}/git/blobs`,token,{method:'POST',body:JSON.stringify({content:f.data,encoding:'base64'})});if(!br.r.ok)throw new Error(`GitHub 파일 업로드 실패: ${f.path}`);return{path:f.path,mode:'100644',type:'blob',sha:br.d.sha}});
  const deletes=[...existing].filter(p=>!paths.has(p)).map(path=>({path,mode:'100644',type:'blob',sha:null}));
  const tree=await gh(`${GH_API}/repos/${owner}/${body.repoName}/git/trees`,token,{method:'POST',body:JSON.stringify({base_tree:baseTree,tree:[...blobs,...deletes]})});if(!tree.r.ok)throw new Error(`GitHub 트리 생성 실패: ${tree.d.message||tree.r.status}`);
  const nc=await gh(`${GH_API}/repos/${owner}/${body.repoName}/git/commits`,token,{method:'POST',body:JSON.stringify({message:created?(body.mode==='update'?'Adopt existing app with OneClick Deployer':'Initial deploy from OneClick Deployer'):'Update from OneClick Deployer',tree:tree.d.sha,parents:[parent]})});if(!nc.r.ok)throw new Error(`GitHub 커밋 생성 실패: ${nc.d.message||nc.r.status}`);
  const ur=await gh(`${GH_API}/repos/${owner}/${body.repoName}/git/refs/heads/${encodeURIComponent(branch)}`,token,{method:'PATCH',body:JSON.stringify({sha:nc.d.sha,force:false})});if(!ur.r.ok)throw new Error(`GitHub 브랜치 업데이트 실패: ${ur.d.message||ur.r.status}`);
  return{owner,repoUrl:`https://github.com/${owner}/${body.repoName}`,commitSha:nc.d.sha,branch,appId};
}
async function deployVercel(body){
  const check=await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(body.repoName)}`,{headers:{Authorization:`Bearer ${body.vercelToken}`}});
  if(check.ok&&body.mode==='create')throw new Error(`안전 차단: Vercel 프로젝트 '${body.repoName}'가 이미 있습니다. 새 앱으로 덮어쓸 수 없습니다.`);
  if(check.status===404&&body.mode==='update')throw new Error(`안전 차단: Vercel 프로젝트 '${body.repoName}'가 없어 업데이트할 수 없습니다.`);
  if(!check.ok&&check.status!==404){const cd=await check.json().catch(()=>({}));throw new Error(`Vercel 프로젝트 확인 실패: ${cd?.error?.message||check.status}`)}
  const r=await fetch('https://api.vercel.com/v13/deployments?skipAutoDetectionConfirmation=1',{method:'POST',headers:{Authorization:`Bearer ${body.vercelToken}`,'Content-Type':'application/json'},body:JSON.stringify({name:body.repoName,project:body.repoName,target:'production',files:body.files.map(f=>({file:f.path,data:f.data,encoding:'base64'}))})});const d=await r.json();if(!r.ok)throw new Error(`Vercel 배포 실패: ${d?.error?.message||r.status}`);return{deploymentId:d.id,state:d.readyState||d.state||'BUILDING',url:d.url?`https://${d.url}`:''};
}
export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({ok:false,error:'POST만 지원합니다.'});
  try{const body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};validate(body);const git=await syncGithub(body);const vercel=await deployVercel(body);return res.json({ok:true,appId:git.appId,git,vercel})}catch(e){return res.status(400).json({ok:false,error:e?.message||'배포 중 오류가 발생했습니다.'})}
}
