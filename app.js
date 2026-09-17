const $ = (id) => document.getElementById(id);
const MAX_RAW = 2.6 * 1024 * 1024;
const TOKEN_KEY = 'oneclick-deployer-tokens-v1';
const HISTORY_KEY = 'oneclick-deployer-history-v1';
const APP_VERSION = '1.6.9';
let packedFiles = [];
let historyItems = [];
let busy = false;
let selectedZipName = '';
let selectedAppId = '';
let autoDetectionOk = false;
let resolvedTargetName = '';
let resolvedTargetSource = '';


function setProgress(value, text) {
  const v = Math.max(0, Math.min(100, value));
  $('progressBar').style.width = `${v}%`;
  $('progressText').textContent = `${v}%`;
  $('stage').textContent = text;
}
function bytes(n){return n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(2)} MB`}

function setBadge(id,state,text){
  const el=$(id);
  if(!el)return;
  el.textContent=text||'';
  el.classList.remove('ok','bad','warn');
  if(state)el.classList.add(state);
}
function slugify(v){
  const s=v.toLowerCase().replace(/\.[^.]+$/,'').replace(/[^a-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,70);
  if(s)return s;
  const d=new Date(),p=n=>String(n).padStart(2,'0');
  return `nirc-app-${String(d.getFullYear()).slice(2)}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}


function currentProjectName(){
  const host=String(location.hostname||'').toLowerCase();
  if(!host.endsWith('.vercel.app'))return '';
  // production 기본 도메인: <project>.vercel.app
  return slugify(host.replace(/\.vercel\.app$/,''));
}

function loadSavedTokens(){
  let stored={};
  try{stored=JSON.parse(localStorage.getItem(TOKEN_KEY)||'{}')||{}}catch{}
  const legacyGh=localStorage.getItem('oneclick-github-token')||
                 localStorage.getItem('githubToken')||
                 localStorage.getItem('oneclick_deployer_github_token')||'';
  const legacyVc=localStorage.getItem('oneclick-vercel-token')||
                 localStorage.getItem('vercelToken')||
                 localStorage.getItem('oneclick_deployer_vercel_token')||'';

  const fieldGh=$('githubToken').value.trim();
  const fieldVc=$('vercelToken').value.trim();
  const gh=fieldGh||stored.github||legacyGh||'';
  const vc=fieldVc||stored.vercel||legacyVc||'';

  if(gh&&!fieldGh)$('githubToken').value=gh;
  if(vc&&!fieldVc)$('vercelToken').value=vc;

  return {githubToken:gh,vercelToken:vc};
}


function decodePackedText(path){
  const f=packedFiles.find(x=>String(x.path||'').toLowerCase()===String(path||'').toLowerCase());
  if(!f||!f.data)return '';
  try{
    const bin=atob(f.data);
    const bytes=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }catch{return ''}
}
function parsePackedJson(path){
  try{
    const t=decodePackedText(path);
    return t?JSON.parse(t):null;
  }catch{return null}
}
function cleanIdentityName(v){
  let s=String(v||'').trim();
  s=s.replace(/\.zip$/i,'').replace(/-\d+$/,'');
  return s;
}
function zipIdentity(){
  const manifest=parsePackedJson('.oneclick-app.json');
  if(manifest?.repoName){
    return {
      repoName:slugify(manifest.repoName),
      appName:String(manifest.appName||manifest.repoName),
      appId:String(manifest.appId||''),
      source:'oneclick manifest'
    };
  }

  const pkg=parsePackedJson('package.json');
  if(pkg?.name){
    const n=slugify(cleanIdentityName(pkg.name));
    if(n)return {repoName:n,appName:String(pkg.displayName||pkg.name),appId:'',source:'package.json'};
  }

  const portal=parsePackedJson('portal.json');
  let portalCandidate=portal?.repoName||portal?.slug||portal?.id||'';
  // 자동 생성 임시 ID는 저장소/프로젝트 이름으로 사용하지 않는다.
  if(/^nirc-app-\d{6,8}-\d{3,6}$/i.test(String(portalCandidate||'')))portalCandidate='';
  const pn=slugify(cleanIdentityName(portalCandidate));
  if(pn)return {repoName:pn,appName:String(portal?.name||portal?.appName||portalCandidate),appId:'',source:'portal.json'};

  const raw=cleanIdentityName(selectedZipName||'');
  let fallback=slugify(raw);
  // 한글 설명이 섞인 파일명은 영문/숫자 조각을 사용하되, 버전 토큰은 제거한다.
  let asciiParts=String(raw).match(/[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*/g)||[];
  asciiParts=asciiParts.filter(x=>!/^v?\d+(?:[._-]\d+)*$/i.test(x));
  if(asciiParts.length){
    const joined=asciiParts.join('-').toLowerCase();
    if(joined.length>=3)fallback=slugify(joined);
  }
  return {repoName:fallback,appName:raw,appId:'',source:'ZIP 이름'};
}

async function autoTargetFromZip(){
  const identity=zipIdentity();
  const candidate=identity.repoName||zipBaseName(selectedZipName||'');
  const current=currentProjectName();
  const detail=$('detectDetail');

  resolvedTargetName='';
  resolvedTargetSource='';
  selectedAppId=identity.appId||'';

  if(!candidate){
    $('autoDecision').textContent='ZIP을 선택하세요';
    $('modeLabel').textContent='자동 판단 대기';
    if(detail)detail.textContent='GitHub: 대기 · Vercel: 대기';
    return false;
  }

  $('appName').value=identity.appName||candidate;
  $('repoName').value=candidate;

  const saved=loadSavedTokens();
  const githubToken=saved.githubToken;
  const vercelToken=saved.vercelToken;

  if(!githubToken||!vercelToken){
    $('autoDecision').textContent=`자동 확인 대기 · ${candidate}`;
    $('modeLabel').textContent='토큰 확인 필요';
    if(detail)detail.textContent=`식별: ${identity.source} · GitHub: ${githubToken?'토큰 있음':'토큰 없음'} · Vercel: ${vercelToken?'토큰 있음':'토큰 없음'}`;
    return false;
  }

  $('autoDecision').textContent=`실제 앱 찾는 중 · ${candidate}`;
  $('modeLabel').textContent='자동 판단 중';
  if(detail)detail.textContent=`식별: ${identity.source} · GitHub/Vercel 실제 목록 확인 중`;

  try{
    const r=await fetch('/api/test',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        provider:'detect',
        githubToken,
        vercelToken,
        repoName:candidate,
        zipName:selectedZipName,
        appName:identity.appName||''
      })
    });
    const d=await r.json().catch(()=>({}));

    if(!r.ok||!d.ok){
      if(detail){
        detail.textContent=`GitHub: ${d.githubError||'확인 불가'} · Vercel: ${d.vercelError||'확인 불가'}`;
      }
      throw new Error(d.error||'자동 확인 실패');
    }

    const target=String(d.resolvedName||candidate);
    const gh=!!d.githubExists;
    const vc=!!d.vercelExists;
    resolvedTargetName=target;
    resolvedTargetSource=String(d.matchType||identity.source||'자동');

    $('repoName').value=target;
    if(!identity.appName||identity.source==='ZIP 이름')$('appName').value=target;

    if(detail){
      const match=d.matchType?` · 판정: ${d.matchType}`:'';
      detail.textContent=`대상: ${target} · GitHub: ${gh?'존재':'없음'} · Vercel: ${vc?'존재':'없음'}${match}`;
    }

    if(gh&&vc){
      const known=historyItems.find(x=>x.repoName===target);
      selectedAppId=identity.appId||known?.appId||'';
      setExistingTargetLock(target,'자동 확인');
      $('autoDecision').textContent=(current&&target===current)
        ?`현재 배포기 업데이트 · ${target}`
        :`기존 앱 자동 확인 · ${target}`;
      $('modeLabel').textContent='기존 앱 업데이트';
      updateDeployButtonLabel();
      return true;
    }

    if(!gh&&!vc){
      clearExistingTargetLock();
      $('mode').value='create';
      selectedAppId='';
      resolvedTargetName=target;
      $('autoDecision').textContent=`새 앱 자동 확인 · ${target}`;
      $('modeLabel').textContent='새 앱 배포';
      updateDeployButtonLabel();
      return true;
    }

    clearExistingTargetLock();
    $('mode').value='update';
    $('autoDecision').textContent=`⚠️ 상태 불일치 · ${target}`;
    $('modeLabel').textContent=gh?'GitHub만 존재 · 배포 차단':'Vercel만 존재 · 배포 차단';
    updateDeployButtonLabel();
    return false;

  }catch(e){
    $('autoDecision').textContent=`자동 확인 실패 · ${candidate}`;
    $('modeLabel').textContent=e?.message||'다시 연결 확인';
    return false;
  }
}

function zipBaseName(name){
  let base=String(name||'').replace(/\.zip$/i,'').trim().toLowerCase();
  // 모바일 브라우저가 같은 파일을 여러 번 받으면 -2, -3 ... 을 붙이는 경우가 있다.
  // 실제 앱 이름 판정에서는 이 다운로드 중복 번호를 제거한다.
  base=base.replace(/-\d+$/,'');
  return base;
}
function zipMatchesTarget(zipName,target){
  const z=zipBaseName(zipName), t=slugify(target||'');
  if(!z||!t)return false;
  return z===t || z.startsWith(t+'-v') || z.startsWith(t+'.') || z.startsWith(t+'_v');
}
function updateDeployButtonLabel(){
  const create=$('mode').value==='create';
  $('deployBtn').textContent=create?'🚀 GitHub 저장 + Vercel 자동 배포':'🔄 기존 앱 자동 업데이트';
}

function refreshSafety(){
  const mode=$('mode').value;
  const target=$('repoName').value.trim();
  const zip=selectedZipName;
  $('safeZip').textContent=zip||'없음';
  $('safeTarget').textContent=target||'없음';
  const panel=$('safetyPanel'), badge=$('safeStatus');
  panel.classList.remove('safe','blocked');

  if(mode==='create'){
    const ok=autoDetectionOk && !!resolvedTargetName && target===resolvedTargetName;
    badge.textContent=ok?'새 앱 · 실제 목록 확인 완료':'새 앱 · 자동 확인 필요';
    badge.className=`badge ${ok?'ok':'warn'}`;
    panel.classList.add(ok?'safe':'blocked');
    return ok;
  }

  // 기존 앱은 ZIP 파일명 자체가 달라도, GitHub/Vercel 실제 조회에서
  // 같은 대상이 확인된 경우에만 안전 업데이트를 허용한다.
  const ok=autoDetectionOk && !!resolvedTargetName && target===resolvedTargetName;
  if(ok){
    const current=currentProjectName();
    badge.textContent=(target===current)
      ?'현재 배포기 자동 확인 · 안전 업데이트'
      :`실제 앱 확인 완료 · ${resolvedTargetSource||'자동 판정'}`;
    badge.className='badge ok';
    panel.classList.add('safe');
  }else{
    badge.textContent='자동 확인 전 · 업데이트 차단';
    badge.className='badge bad';
    panel.classList.add('blocked');
  }
  return ok;
}

function shouldIgnore(path){
  const p=path.replace(/^\.\//,''); const parts=p.split('/'); const base=parts.at(-1).toLowerCase();
  return parts.includes('node_modules')||parts.includes('.git')||parts.includes('__MACOSX')||base==='.ds_store'||base==='thumbs.db'||base==='.env'||base.startsWith('.env.');
}
function u16(d,o){return d.getUint16(o,true)}
function u32(d,o){return d.getUint32(o,true)}
function findEOCD(bytes){
  const min=Math.max(0,bytes.length-0xffff-22); const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(let i=bytes.length-22;i>=min;i--) if(u32(dv,i)===0x06054b50)return i;
  return -1;
}
async function inflateRaw(data){
  if(!('DecompressionStream' in window)) throw new Error('이 브라우저는 ZIP 압축 해제를 지원하지 않습니다. 최신 Chrome/Edge를 사용하세요.');
  const ds=new DecompressionStream('deflate-raw');
  const stream=new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function toBase64(bytes){
  let binary=''; const step=0x8000;
  for(let i=0;i<bytes.length;i+=step) binary+=String.fromCharCode(...bytes.subarray(i,i+step));
  return btoa(binary);
}
async function readZip(file){
  const raw=new Uint8Array(await file.arrayBuffer());
  const dv=new DataView(raw.buffer,raw.byteOffset,raw.byteLength); const eocd=findEOCD(raw);
  if(eocd<0) throw new Error('정상적인 ZIP 파일이 아닙니다.');
  const count=u16(dv,eocd+10), centralOffset=u32(dv,eocd+16);
  if(count>500) throw new Error('ZIP 안의 파일이 너무 많습니다. 첫 버전은 500개 이하를 검사합니다.');
  let pos=centralOffset; const entries=[]; const decoder=new TextDecoder('utf-8');
  for(let i=0;i<count;i++){
    if(u32(dv,pos)!==0x02014b50) throw new Error('ZIP 중앙 디렉터리를 읽지 못했습니다.');
    const flags=u16(dv,pos+8), method=u16(dv,pos+10), cSize=u32(dv,pos+20), size=u32(dv,pos+24);
    const nameLen=u16(dv,pos+28), extraLen=u16(dv,pos+30), commentLen=u16(dv,pos+32), localOffset=u32(dv,pos+42);
    if(flags&1) throw new Error('암호화된 ZIP은 지원하지 않습니다.');
    const name=decoder.decode(raw.subarray(pos+46,pos+46+nameLen)).replace(/\\/g,'/');
    if(!name.endsWith('/')) entries.push({name,method,cSize,size,localOffset});
    pos+=46+nameLen+extraLen+commentLen;
  }
  const kept=entries.filter(e=>!shouldIgnore(e.name)); const ignored=entries.filter(e=>shouldIgnore(e.name)).map(e=>e.name);
  if(!kept.length) throw new Error('배포할 파일이 없습니다.');
  const roots=kept.map(e=>e.name.split('/')[0]);
  const flatten=kept.every(e=>e.name.includes('/'))&&roots.every(r=>r===roots[0]); const root=flatten?`${roots[0]}/`:'';
  const out=[];
  for(const e of kept){
    if(u32(dv,e.localOffset)!==0x04034b50) throw new Error(`ZIP 파일 헤더 오류: ${e.name}`);
    const n=u16(dv,e.localOffset+26),x=u16(dv,e.localOffset+28),start=e.localOffset+30+n+x;
    const compressed=raw.subarray(start,start+e.cSize);
    let data;
    if(e.method===0) data=new Uint8Array(compressed);
    else if(e.method===8) data=await inflateRaw(compressed);
    else throw new Error(`지원하지 않는 ZIP 압축 방식입니다: ${e.name}`);
    const path=(root?e.name.slice(root.length):e.name).replace(/^\/+/, '');
    if(!path||path.includes('..')||path.includes('\\')) throw new Error(`허용되지 않는 파일 경로: ${path}`);
    out.push({path,data:toBase64(data),size:data.length});
  }
  out.sort((a,b)=>a.path.localeCompare(b.path));
  return {files:out,ignored,flatten};
}
function saveTokens(){
  if(!$('remember').checked)return;
  localStorage.setItem(TOKEN_KEY,JSON.stringify({github:$('githubToken').value.trim(),vercel:$('vercelToken').value.trim(),supabase:$('supabaseToken').value.trim()}));
}
function loadSaved(){
  try{const t=JSON.parse(localStorage.getItem(TOKEN_KEY)||'{}');$('githubToken').value=t.github||'';$('vercelToken').value=t.vercel||'';$('supabaseToken').value=t.supabase||''}catch{}
  try{historyItems=JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]')}catch{historyItems=[]}
  renderHistory(); loadSavedTokens();
updateReady();
}
function renderHistory(){
  const sel=$('historySelect');
  if(!sel)return;
  const prev=sel.value;
  sel.innerHTML='<option value="">자동 찾기 / 새 앱</option>';
  for(const item of historyItems){
    if(!item?.repoName)continue;
    const o=document.createElement('option');
    o.value=item.repoName;
    o.textContent=`${item.appName||item.repoName} · ${item.repoName}`;
    sel.appendChild(o);
  }
  if(historyItems.some(x=>x.repoName===prev))sel.value=prev;
}
function selectedHistoryItem(){
  const v=$('historySelect')?.value||'';
  return historyItems.find(x=>x.repoName===v)||null;
}
function setExistingTargetLock(repoName, source='기존 앱'){
  const target=String(repoName||'').trim();
  if(!target)return;
  $('repoName').value=target;
  $('repoName').readOnly=true;
  $('repoName').classList.add('locked');
  $('mode').value='update';
  $('mode').disabled=true;
  const note=$('repoLockNote');
  if(note)note.textContent=`🔒 주소 고정: https://${target}.vercel.app · ZIP 이름이 바뀌어도 이 주소로 업데이트`;
  const addr=$('lockedAddress');
  if(addr){addr.textContent=`https://${target}.vercel.app`;addr.classList.remove('hidden');}
}
function clearExistingTargetLock(){
  $('repoName').readOnly=false;
  $('repoName').classList.remove('locked');
  $('mode').disabled=false;
  const note=$('repoLockNote'); if(note)note.textContent='';
  const addr=$('lockedAddress'); if(addr){addr.textContent='';addr.classList.add('hidden');}
}
function applyHistoryTarget(item){
  if(!item)return false;
  $('repoName').value=item.repoName;
  if(item.appName)$('appName').value=item.appName;
  selectedAppId=item.appId||'';
  resolvedTargetName=item.repoName;
  resolvedTargetSource='기존 앱 빠른 선택';
  autoDetectionOk=true;
  setExistingTargetLock(item.repoName,'기존 앱 빠른 선택');
  $('autoDecision').textContent=`기존 앱 선택 · ${item.repoName}`;
  $('modeLabel').textContent='기존 앱 업데이트';
  const detail=$('detectDetail'); if(detail)detail.textContent='저장된 앱 고유 ID로 안전 업데이트 · ZIP 이름이 달라도 가능';
  updateDeployButtonLabel(); refreshSafety(); updateReady();
  return true;
}
function releaseHistoryTarget(){
  clearExistingTargetLock();
}

async function redetectIfNeeded(){
  const forced=selectedHistoryItem();
  if(forced){
    applyHistoryTarget(forced);
    return true;
  }
  releaseHistoryTarget();
  if(!selectedZipName || !packedFiles.length){
    autoDetectionOk=false;
    resolvedTargetName='';
    resolvedTargetSource='';
    updateReady();
    return false;
  }

  autoDetectionOk=false;
  resolvedTargetName='';
  resolvedTargetSource='';

  const ok=await autoTargetFromZip();
  autoDetectionOk=!!ok;

  refreshSafety();
  updateReady();
  return autoDetectionOk;
}

function updateReady(){
  const raw=packedFiles.reduce((a,f)=>a+(f.size||0),0);
  const githubOk=!!$('githubToken').value.trim();
  const vercelOk=!!$('vercelToken').value.trim();
  const fileOk=packedFiles.length>0&&raw<=MAX_RAW;
  const nameOk=!!$('appName').value.trim()&&!!$('repoName').value.trim();
  const safetyOk=refreshSafety();
  const ok=!busy&&fileOk&&nameOk&&githubOk&&vercelOk&&safetyOk&&autoDetectionOk;

  $('deployBtn').disabled=!ok;
  $('deployBtn').style.opacity=ok?'1':'0.55';
  $('deployBtn').style.cursor=ok?'pointer':'not-allowed';

  if(fileOk&&nameOk&&githubOk&&vercelOk&&safetyOk){
    setProgress(0,'준비 완료');
  }else if(fileOk&&nameOk&&safetyOk){
    setProgress(0,'토큰 확인 필요');
  }else if(fileOk){
    setProgress(0,'설정 확인 필요');
  }
  return ok;
}
async function chooseZip(file){
  selectedZipName=file?.name||'';
  packedFiles=[];$('fileInfo').classList.add('hidden');$('parseError').classList.add('hidden');setProgress(0,'ZIP 검사 중');
  try{
    const z=await readZip(file);packedFiles=z.files;$('zipLabel').textContent=file.name;
    const base=file.name.replace(/\.zip$/i,'');
    const forced=selectedHistoryItem();
    if(forced){
      $('appName').value=forced.appName||base;
      $('repoName').value=forced.repoName;
      selectedAppId=forced.appId||'';
      resolvedTargetName=forced.repoName;
      resolvedTargetSource='기존 앱 빠른 선택';
    }else{
      $('appName').value=base;$('repoName').value=slugify(base);resolvedTargetName='';resolvedTargetSource='';
    }
    const total=packedFiles.reduce((s,f)=>s+f.size,0),hasRoot=packedFiles.some(f=>f.path==='index.html'||f.path==='package.json'),hasSb=packedFiles.some(f=>f.path.toLowerCase().startsWith('supabase/'));
    $('fileMeta').innerHTML=`<span>${packedFiles.length}개 파일</span><span>${bytes(total)}</span>${z.flatten?'<span>최상위 폴더 자동 제거</span>':''}${hasSb?'<span>Supabase 폴더 감지</span>':''}`;
    $('structureStatus').textContent=hasRoot?'정상':'확인 필요';$('structureStatus').className=`badge ${hasRoot?'ok':'warn'}`;
    $('ignoredNote').classList.toggle('hidden',z.ignored.length===0);$('ignoredNote').textContent=z.ignored.length?`보안을 위해 ${z.ignored.length}개 파일을 자동 제외했습니다: .env / .git / node_modules 등`:'';
    $('sizeNote').classList.toggle('hidden',total<=MAX_RAW);$('supabaseNote').classList.toggle('hidden',!hasSb);$('fileInfo').classList.remove('hidden');setProgress(0,'ZIP 준비 완료');await redetectIfNeeded();
  }catch(e){$('parseError').textContent=e.message||'ZIP 파일을 읽지 못했습니다.';$('parseError').classList.remove('hidden');setProgress(0,'ZIP 오류');updateReady()}
}
async function pollVercel(token,id){
  for(let i=0;i<16;i++){
    await new Promise(r=>setTimeout(r,1800));setProgress(Math.min(96,80+i),'Vercel 빌드 확인 중');
    const r=await fetch('/api/vercel-status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,deploymentId:id})});const d=await r.json();
    if(d.ok&&d.state==='READY')return d;if(d.ok&&(d.state==='ERROR'||d.state==='CANCELED'))throw new Error(`Vercel 상태: ${d.state}`);
  }
  return null;
}
async function deploy(){
  let completed=false;
  let completedText='배포 완료';
  if($('deployBtn').disabled||busy)return;busy=true;updateReady();$('deployError').classList.add('hidden');$('deployResult').classList.add('hidden');$('launchBtn').classList.add('hidden');$('launchBtn').removeAttribute('href');setProgress(10,'GitHub 저장 시작');
  const lockedRepoName=$('repoName').readOnly ? $('repoName').value.trim() : '';
  const payload={appName:$('appName').value.trim(),repoName:$('repoName').value.trim(),visibility:$('visibility').value,mode:$('mode').value,zipName:selectedZipName,expectedAppId:selectedAppId||'',lockedRepoName,lockSource:resolvedTargetSource||'',clientVersion:APP_VERSION,githubToken:$('githubToken').value.trim(),vercelToken:$('vercelToken').value.trim(),files:packedFiles};
  try{
    const r=await fetch('/api/deploy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'배포 실패');
    setProgress(80,'GitHub 저장 완료 · Vercel 배포 중');let st=null;if(d.vercel.deploymentId)st=await pollVercel(payload.vercelToken,d.vercel.deploymentId);
    const finalUrl=st?.alias||st?.url||d.vercel.url||'';const state=st?.state||d.vercel.state||'BUILDING';completed=true;completedText=state==='READY'?'배포 완료':'배포 요청 완료';setProgress(100,completedText);
    $('resultTitle').textContent=state==='READY'?'✅ 배포 완료':'✅ 배포 요청 완료';$('repoLink').href=d.git.repoUrl;$('repoLink').textContent=d.git.repoUrl;$('vercelLink').href=finalUrl;$('vercelLink').textContent=finalUrl;$('vercelState').textContent=state;$('commitSha').textContent=String(d.git.commitSha).slice(0,10);if(finalUrl){$('launchBtn').href=finalUrl;$('launchBtn').classList.remove('hidden')}$('deployResult').classList.remove('hidden');
    const launch=$('launchBtn');
    if(launch){
      launch.href=finalUrl;
      launch.classList.remove('hidden');
    }
    const item={appName:payload.appName,repoName:payload.repoName,repoUrl:d.git.repoUrl,url:finalUrl,appId:d.appId||payload.expectedAppId||'',at:new Date().toISOString()};historyItems=[item,...historyItems.filter(x=>x.repoName!==item.repoName)].slice(0,20);localStorage.setItem(HISTORY_KEY,JSON.stringify(historyItems));renderHistory();$('historySelect').value=item.repoName;applyHistoryTarget(item);$('mode').value='update';saveTokens();
  }catch(e){
    if(completed){
      console.warn('배포 완료 후 UI 정리 오류:',e);
    }else{
      $('deployErrorText').textContent=e.message||'배포 중 오류가 발생했습니다.';
      $('deployError').classList.remove('hidden');
      setProgress(0,'오류');
    }
  }
  finally{
    busy=false;
    updateReady();
    // updateReady()는 버튼 활성 상태를 다시 계산하면서 진행률을 20%로 바꿀 수 있다.
    // 배포가 성공했다면 최종 상태를 다시 100%로 고정한다.
    if(completed)setProgress(100,completedText);
  }
}



$('zipInput').addEventListener('change',e=>{const f=e.target.files?.[0];if(f)chooseZip(f)});

async function testProvider(provider){
  const map={
    github:{tokenId:'githubToken',statusId:'githubStatus',label:'GitHub'},
    vercel:{tokenId:'vercelToken',statusId:'vercelStatus',label:'Vercel'},
    supabase:{tokenId:'supabaseToken',statusId:'supabaseStatus',label:'Supabase'}
  };
  const cfg=map[provider];
  if(!cfg)return;

  const token=$(cfg.tokenId)?.value?.trim()||'';
  if(!token){
    setBadge(cfg.statusId,'bad','토큰 없음');
    return;
  }

  setBadge(cfg.statusId,'','확인 중');

  try{
    const r=await fetch('/api/test',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({provider,token})
    });

    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.ok){
      const msg=d.error||`${cfg.label} 연결 실패`;
      setBadge(cfg.statusId,'bad','실패');
      alert(`${cfg.label} 연결 실패\n${msg}`);
      return;
    }

    setBadge(cfg.statusId,'ok','연결됨');
    saveTokens();

    // GitHub/Vercel 연결이 확인되면 ZIP이 이미 선택된 경우 자동판정을 다시 실행
    if(provider==='github'||provider==='vercel'){
      await redetectIfNeeded();
    }else{
      updateReady();
    }
  }catch(e){
    setBadge(cfg.statusId,'bad','실패');
    alert(`${cfg.label} 연결 실패\n${e?.message||e}`);
  }
}

$('testGithub').addEventListener('click',()=>testProvider('github'));
$('testVercel').addEventListener('click',()=>testProvider('vercel'));
$('testSupabase').addEventListener('click',()=>testProvider('supabase'));
$('clearTokens').addEventListener('click',()=>{localStorage.removeItem(TOKEN_KEY);$('githubToken').value='';$('vercelToken').value='';$('supabaseToken').value='';setBadge('githubStatus','','확인 전');setBadge('vercelStatus','','확인 전');setBadge('supabaseStatus','','확인 전');updateReady()});
for(const id of ['githubToken','vercelToken','supabaseToken','appName'])$(id).addEventListener('input',()=>{saveTokens();redetectIfNeeded()});
$('repoName').addEventListener('input',e=>{const pos=e.target.selectionStart;e.target.value=slugify(e.target.value);try{e.target.setSelectionRange(pos,pos)}catch{}resolvedTargetName='';resolvedTargetSource='';autoDetectionOk=false;const h=historyItems.find(x=>x.repoName===e.target.value);selectedAppId=h?.appId||'';updateReady()});
$('remember').addEventListener('change',()=>{if($('remember').checked)saveTokens();else localStorage.removeItem(TOKEN_KEY)});
$('mode').addEventListener('change',()=>{if($('mode').value==='create')selectedAppId='';updateDeployButtonLabel();updateReady()});
$('historySelect').addEventListener('change',async()=>{const item=selectedHistoryItem(); if(item){applyHistoryTarget(item); if(selectedZipName&&packedFiles.length)await redetectIfNeeded();}else{releaseHistoryTarget(); selectedAppId=''; autoDetectionOk=false; resolvedTargetName=''; resolvedTargetSource=''; if(selectedZipName&&packedFiles.length)await redetectIfNeeded(); else updateReady();}});
$('deployBtn').addEventListener('click',deploy);
loadSaved();setProgress(0,'준비');

$('githubToken').addEventListener('input',redetectIfNeeded);
$('vercelToken').addEventListener('input',redetectIfNeeded);
$('appName').addEventListener('input',updateReady);
updateDeployButtonLabel();
updateReady();
