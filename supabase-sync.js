/* MHSARBIDE / Supabase. Never use a secret or service-role key in a browser.
 * Defensive, append-only snapshots. No deletes, no schema migrations.
 * Pull and merge happen before any write is permitted.
 */
(()=>{
'use strict';
const URL_BASE='https://hargvujvwhwmvodlbarh.supabase.co';
const PUB='sb_publishable_alaHLd7sOSjAWRzKWLjRHg_-igTTOx8';
const DATA_TYPE='mhsarbide_sync_piloto_v1';
const SESSION_KEY='mhs_sb_user_session_v1';
const DRAFT_KEY='mhs_sb_pending_edit_v1';
let session=null,ready=false,reading=false,busy=false,lastError='',timer=null,rev=0;
const status=()=>({connected:!!session,ready,busy,error:lastError});
const signal=()=>window.dispatchEvent(new Event('mhs-supabase-status'));
function persist(){if(session)localStorage.setItem(SESSION_KEY,JSON.stringify(session));else localStorage.removeItem(SESSION_KEY);signal()}
function makeHeaders(token='',extra={}){return {'apikey':PUB,...(token?{'Authorization':'Bearer '+token}:{}),...extra}}
async function request(path,opts={}){
 if(!navigator.onLine)throw Error('Sin conexión');
 let resp=await fetch(URL_BASE+path,{...opts,headers:makeHeaders(session?.access_token,opts.headers||{})});
 if(resp.status===401&&session?.refresh_token){await refresh();resp=await fetch(URL_BASE+path,{...opts,headers:makeHeaders(session.access_token,opts.headers||{})});}
 if(!resp.ok){const t=await resp.text().catch(()=>'');throw Error('Supabase HTTP '+resp.status+': '+t.slice(0,140))}
 const raw=await resp.text();return raw?JSON.parse(raw):null;
}
async function refresh(){
 const old=session?.refresh_token;if(!old)throw Error('Inicia sesión');
 const r=await fetch(URL_BASE+'/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:makeHeaders('',{'Content-Type':'application/json'}),body:JSON.stringify({refresh_token:old})});
 if(!r.ok){session=null;ready=false;persist();throw Error('La sesión ha caducado; vuelve a identificarte')}
 const d=await r.json();session={...d,expires_at:Date.now()+d.expires_in*1000};persist();return session;
}
async function ensureSession(){
 if(!session)return false;
 if(Date.now()>(session.expires_at||0)-60000)await refresh();
 const r=await request('/auth/v1/user');
 if(!r?.id)throw Error('Identidad de Supabase no válida');
 session.user={id:r.id,email:r.email};persist();return true;
}
function showMessage(msg){lastError=String(msg||'');console.warn('MHS Supabase:',lastError);signal()}
function modal(){
 let d=document.getElementById('mhsSbLogin');if(d)return d;
 d=document.createElement('dialog');d.id='mhsSbLogin';d.style.cssText='border:1px solid #ccd8cf;border-radius:12px;padding:22px;max-width:380px;width:calc(100% - 32px);box-shadow:0 15px 40px #0004;font:15px Arial';
 d.innerHTML='<form id="mhsSbForm" method="dialog"><h3 style="margin-top:0">Acceso a tus datos</h3><p>Inicia sesión con el usuario de Supabase que tiene acceso a tus hojas.</p><label>Correo electrónico<input required autocomplete="username" type="email" id="mhsSbEmail" style="display:block;width:100%;padding:8px;margin:6px 0 12px"></label><label>Contraseña<input required autocomplete="current-password" type="password" id="mhsSbPass" style="display:block;width:100%;padding:8px;margin:6px 0 12px"></label><p id="mhsSbError" role="alert" style="color:#a22"></p><div style="display:flex;gap:10px"><button type="submit" style="padding:10px">Conectar</button><button type="button" id="mhsSbClose" style="padding:10px">Cerrar</button></div></form>';
 document.body.appendChild(d);
 d.querySelector('#mhsSbClose').onclick=()=>d.close();
 d.querySelector('#mhsSbForm').addEventListener('submit',async e=>{
  e.preventDefault();const error=d.querySelector('#mhsSbError');error.textContent='Conectando…';
  try{
   const r=await fetch(URL_BASE+'/auth/v1/token?grant_type=password',{method:'POST',headers:makeHeaders('',{'Content-Type':'application/json'}),body:JSON.stringify({email:d.querySelector('#mhsSbEmail').value.trim(),password:d.querySelector('#mhsSbPass').value})});
   if(!r.ok)throw Error('Acceso rechazado. Comprueba los datos o si tu cuenta tiene acceso mediante Auth.');
   const data=await r.json();session={...data,expires_at:Date.now()+data.expires_in*1000};persist();
   d.querySelector('#mhsSbPass').value='';d.close();lastError='';await pull();
  }catch(err){error.textContent=String(err.message||err);showMessage(err.message||err)}
 });return d;
}
function openLogin(){const d=modal();if(!d.open)d.showModal()}
function validSnapshot(x){return !!x&&typeof x==='object'&&Array.isArray(x.services)&&Array.isArray(x.clients||[])&&Array.isArray(x.products||[])}
function parseSnapshot(v){
 if(typeof v==='string'){try{v=JSON.parse(v)}catch{return null}}
 if(validSnapshot(v?.state))return v.state;
 if(validSnapshot(v?.data?.state))return v.data.state;
 if(validSnapshot(v))return v;
 return null;
}
function mergeItems(local=[],remote=[]){
 const m=new Map();const key=x=>String(x?.id||x?.record_id||'');
 for(const x of remote){if(x&&key(x))m.set(key(x),x)}
 for(const x of local){if(!x||!key(x))continue;const old=m.get(key(x));
  // Never replace a record with a copy lacking photos or attachments.
  if(!old){m.set(key(x),x);continue}
  const newer=(Date.parse(x.updatedAt||x.modifiedAt||'')||0)>(Date.parse(old.updatedAt||old.modifiedAt||'')||0);
  const merged={...(newer?old:x),...(newer?x:old)};
  if(old.photos||x.photos){merged.photos={...(old.photos||{}),...(x.photos||{})};for(const [k,v] of Object.entries(old.photos||{}))if(!merged.photos[k]||merged.photos[k]==='[adjunto-local]')merged.photos[k]=v}
  if(old.attachments||x.attachments){const at=new Map();for(const a of [...(old.attachments||[]),...(x.attachments||[])])if(a?.id)at.set(a.id,{...(at.get(a.id)||{}),...a});merged.attachments=Array.from(at.values())}
  m.set(key(x),merged);
 }
 return [...m.values()];
}
function mergeState(local,remote){
 const result={...remote,...local};
 for(const k of ['services','clients','products','invoices','budgets'])result[k]=mergeItems(local[k],remote[k]);
 result.company={...(remote.company||{}),...(local.company||{})};
 if(Object.keys(local.company||{}).length===0)result.company=remote.company||{};
 result.numbering={...(remote.numbering||{}),...(local.numbering||{})};
 result.numbering.serviceNext=Math.max(Number(remote.numbering?.serviceNext)||0,Number(local.numbering?.serviceNext)||0,26001);
 return result;
}
async function pull(){
 if(reading)return;reading=true;busy=true;signal();
 try{
  if(!await ensureSession())return;
  const userId=session.user.id;
  const rows=await request('/rest/v1/app_data?select=data_json,created_at,record_id_text&user_id=eq.'+encodeURIComponent(userId)+'&data_type=eq.'+encodeURIComponent(DATA_TYPE)+'&order=created_at.desc&limit=50');
  const snapshots=(rows||[]).map(r=>({state:parseSnapshot(r.data_json),stamp:r.created_at})).filter(r=>r.state);
  if(!snapshots.length){ready=false;showMessage('No hay instantáneas reconocibles para esta cuenta. No se enviarán datos para proteger los registros existentes.');return}
  // Merge snapshots oldest to newest so all historical entities can be recovered.
  let remote=snapshots[snapshots.length-1].state;
  for(let i=snapshots.length-2;i>=0;i--)remote=mergeState(remote,snapshots[i].state);
  const local=window.MHSApp?.getState?.();if(!local)throw Error('La aplicación aún no está preparada');
  const merged=mergeState(local,remote);
  await window.MHSApp.applyRemoteState(merged,{source:'supabase'});
  ready=true;lastError='';signal();
  // Existing local changes require their own snapshot, never overwrite automatically at startup.
 }catch(e){ready=false;showMessage(e.message||e)}
 finally{reading=false;busy=false;signal()}
}
function noteEdit(){rev++;try{localStorage.setItem(DRAFT_KEY,String(Date.now()))}catch{};clearTimeout(timer);timer=setTimeout(push,5000)}
async function push(){
 if(!ready||!session||busy||!navigator.onLine)return;
 const currentRevision=rev;busy=true;signal();
 try{
  if(!await ensureSession())return;
  const state=window.MHSApp?.getState?.();if(!validSnapshot(state))throw Error('Estado no válido');
  const id=crypto.randomUUID();
  await request('/rest/v1/app_data',{method:'POST',headers:{'Content-Type':'application/json','Prefer':'return=minimal'},body:JSON.stringify({id,user_id:session.user.id,data_type:DATA_TYPE,record_id_text:id,data_json:{state,updatedAt:new Date().toISOString()}})});
  lastError='';if(currentRevision===rev)localStorage.removeItem(DRAFT_KEY);
 }catch(e){showMessage('Guardado local correcto, sincronización pendiente: '+(e.message||e))}
 finally{busy=false;signal()}
}
let started=false;
async function start(){
 if(started)return;started=true;
 try{session=JSON.parse(localStorage.getItem(SESSION_KEY)||'null')}catch{session=null}
 signal();if(!session){openLogin();return}if(window.MHSOffline?.loadState)await window.MHSOffline.loadState().catch(()=>{});await new Promise(r=>setTimeout(r,100));await pull();
}
window.addEventListener('online',async()=>{if(session&&!ready)await pull();if(ready&&localStorage.getItem(DRAFT_KEY))await push()});
setInterval(async()=>{if(!session||!navigator.onLine||busy)return;if(!ready)await pull();else if(localStorage.getItem(DRAFT_KEY))await push()},60000);
window.MHSSupabase={start,status,openLogin,noteEdit,pull,push};
})();
