/* MHSARBIDE — Conexión Supabase revisada. No modifica las tablas antiguas.
   Registro inmutable de versiones en app_data. Ante cualquier divergencia, DETIENE la sincronización.
   No se usa en producción hasta superar las pruebas en los tres dispositivos. */
(()=>{
'use strict';
const URL='https://hargvujvvhwmvodlbarh.supabase.co';
const KEY='sb_publishable_alaHLd7sOSjAWRzKWLjRHg_-igTTOx8'; // Clave pública del cliente original; NUNCA service_role.
const NS='hmsarbide_sync_piloto_v1';
const PHOTO_BUCKET='adjuntos'; // Bucket EXISTENTE en el Supabase original. Políticas a verificar sin modificarlas.
const DB='mhs_integracion_supabase_journal_v1';
const STATE_STORE='journal';
const event=(name,detail={})=>window.dispatchEvent(new CustomEvent('hms-sync-status',{detail:{name,...detail}}));
let client=null,sessionUser=null,working=false,suppressed=false,auto=false,timer=null;
// La recuperación no toca datos ni inicia la sincronización.
let recoveryGranted=false;
let recoveryNotice='';
let recoveryUI=null;
// Capturamos el enlace de recuperación ANTES de que Supabase o la interfaz lo procesen.
// Los tokens se usan una sola vez en memoria; se retiran inmediatamente de la URL.
const returnParams=new URLSearchParams(location.hash.replace(/^#/,''));
const recoveryReturn=(returnParams.get('type')==='recovery' && !!returnParams.get('access_token') && !!returnParams.get('refresh_token'))
  ? {access_token:returnParams.get('access_token'),refresh_token:returnParams.get('refresh_token')}:null;
const recoveryReturnError=returnParams.get('error_code')||returnParams.get('error')||'';
if(recoveryReturn || recoveryReturnError){
 history.replaceState(null,'',location.pathname+location.search);
}

function displayRecovery(){
 if(!recoveryUI)return;
 recoveryUI.panel.hidden=false;
 recoveryUI.area.hidden=!recoveryGranted;
 recoveryUI.status.textContent=recoveryNotice||(recoveryGranted?'Enlace de recuperación validado. Escribe la contraseña nueva.':'Solicita un enlace nuevo desde esta aplicación.');
}
async function sendRecovery(email){
 if(!navigator.onLine)throw Error('Conecta Internet para solicitar el correo.');
 if(!email||!/^\S+@\S+\.\S+$/.test(email))throw Error('Introduce un correo electrónico válido.');
 const redirectTo=location.origin+location.pathname;
 const {error}=await sdk().auth.resetPasswordForEmail(email,{redirectTo});
 if(error)throw error;
 return 'Si el usuario existe, Supabase enviará un enlace. Ábrelo una sola vez; volverá a esta misma aplicación.';
}
async function finishRecovery(password,confirmPassword){
 if(!recoveryGranted)throw Error('No hay un enlace de recuperación válido.');
 if(password.length<12)throw Error('La contraseña nueva debe tener al menos 12 caracteres.');
 if(password!==confirmPassword)throw Error('Las dos contraseñas no coinciden.');
 const {error}=await sdk().auth.updateUser({password});
 if(error)throw error;
 recoveryGranted=false;auto=false;
 await sdk().auth.signOut({scope:'local'});
 recoveryNotice='Contraseña actualizada. Ya puedes entrar con tu correo y la nueva contraseña.';
 displayRecovery();
 return recoveryNotice;
}
let dbPromise=null;
function openDB(){
 if(dbPromise)return dbPromise;
 dbPromise=new Promise((resolve,reject)=>{
  const r=indexedDB.open(DB,1);
  r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(STATE_STORE))r.result.createObjectStore(STATE_STORE);};
  r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
 });return dbPromise;
}
async function get(k){const db=await openDB();return new Promise((resolve,reject)=>{const t=db.transaction(STATE_STORE,'readonly');const r=t.objectStore(STATE_STORE).get(k);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function set(k,v){const db=await openDB();return new Promise((resolve,reject)=>{const t=db.transaction(STATE_STORE,'readwrite');t.objectStore(STATE_STORE).put(v,k);t.oncomplete=resolve;t.onerror=()=>reject(t.error);});}
// Escribe varios marcadores como una sola transacción (sin borrar otras claves).
async function setMany(entries){
 const db=await openDB();
 return new Promise((resolve,reject)=>{
  const t=db.transaction(STATE_STORE,'readwrite');const store=t.objectStore(STATE_STORE);
  for(const [key,value] of entries)store.put(value,key);
  t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);
 });
}
// Comparación estable para evitar diferencias por el orden de las claves JSON.
function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object'){
  const normalized={...value};
  // Una imagen puede estar en memoria como data: para imprimir y en Supabase
  // como mhsstorage:. Ambas representan el mismo fichero si coinciden las huellas.
  if(normalized.photos && normalized.photoCloud){
   normalized.photos={...normalized.photos};
   for(const [k,ref] of Object.entries(normalized.photoCloud)){
    if(ref?.path && normalized.photos[k])normalized.photos[k]='mhsstorage:'+ref.path;
   }
  }
  if(normalized.remotePath){
   delete normalized.blobId;delete normalized.localOnly;delete normalized.syncStatus;
  }
  return Object.fromEntries(Object.keys(normalized).sort().map(k=>[k,canonical(normalized[k])]));
 }
 return value;
}
const sameState=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));

const uid=()=>crypto.randomUUID?crypto.randomUUID():('r'+Date.now()+'-'+Math.random().toString(36).slice(2));
const snapshot=()=>window.MHSApp?.getState?.();
const isEmpty=s=>!(s?.clients?.length||s?.services?.length||s?.invoices?.length||s?.products?.length||s?.budgets?.length||Object.values(s?.company||{}).some(Boolean));

// Fotos y documentos se guardan en un bucket PRIVADO. Nunca se envían a otro
// usuario: las rutas comienzan por auth.uid(), ver políticas incluidas en README.
const imagePrefix='mhsstorage:';
async function digestText(text){
 const bytes=new TextEncoder().encode(text);
 const hash=await crypto.subtle.digest('SHA-256',bytes);
 return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
}
function blobFromDataUri(data){
 const m=/^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/i.exec(data||'');
 if(!m)throw Error('Formato de fotografía no compatible. Conservada en este dispositivo.');
 const raw=atob(m[2]);const bytes=new Uint8Array(raw.length);
 for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
 return new Blob([bytes],{type:m[1]});
}
function asDataUri(blob){return new Promise((res,rej)=>{const f=new FileReader();f.onload=()=>res(f.result);f.onerror=()=>rej(f.error||Error('Error leyendo fotografía'));f.readAsDataURL(blob);});}
function safePart(text){return encodeURIComponent(String(text||'sin-id')).replace(/%/g,'_').slice(0,110);}
async function uploadToStorage(path,blob,type){
 const {error}=await sdk().storage.from(PHOTO_BUCKET).upload(path,blob,{contentType:type||blob.type||'application/octet-stream',upsert:true,cacheControl:'3600'});
 if(error)throw Error('No se pudo subir fotografía/adjunto a Supabase Storage ('+PHOTO_BUCKET+'): '+error.message+'. Los datos locales permanecen guardados.');
}
async function cloudReadyState(local){
 const cloud=typeof structuredClone==='function'?structuredClone(local):JSON.parse(JSON.stringify(local));
 const updates=[];
 for(const svc of cloud.services||[]){
  svc.photoCloud=svc.photoCloud||{};
  for(const [key,src] of Object.entries(svc.photos||{})){
   if(typeof src!=='string'||!src.startsWith('data:image/'))continue;
   const sha=await digestText(src);
   const current=svc.photoCloud[key];
   let path;
   if(current?.sha===sha && current.path){path=current.path;}
   else{
    const blob=blobFromDataUri(src);
    const ext=blob.type==='image/png'?'png':blob.type==='image/webp'?'webp':'jpg';
    path=`${sessionUser.id}/photos/${safePart(svc.id)}/${safePart(key)}-${sha.slice(0,24)}.${ext}`;
    await uploadToStorage(path,blob,blob.type);
   }
   svc.photoCloud[key]={sha,path};
   svc.photos[key]=imagePrefix+path;
  }
  for(const a of svc.attachments||[]){
   if(!a?.blobId || a.remotePath)continue;
   const record=await window.MHSOffline?.getBlob?.(a.blobId);
   if(!record?.blob)throw Error('El adjunto '+(a.name||a.id)+' no está disponible en este dispositivo. No se enviará una copia incompleta.');
   const path=`${sessionUser.id}/attachments/${safePart(svc.id)}/${safePart(a.id)}`;
   await uploadToStorage(path,record.blob,a.type);
   a.remotePath=path;a.localOnly=false;a.syncStatus='synced';
   delete a.blobId;
  }
  if(Object.keys(svc.photoCloud).length===0)delete svc.photoCloud;
  if(svc.photoCloud || (svc.attachments||[]).some(a=>a.remotePath))updates.push({id:svc.id,photoCloud:svc.photoCloud||{},attachments:svc.attachments||[]});
 }
 return {cloud,updates};
}
async function restoreRemoteFiles(cloud){
 const remote=typeof structuredClone==='function'?structuredClone(cloud):JSON.parse(JSON.stringify(cloud));
 for(const svc of remote.services||[]){
  for(const [key,src] of Object.entries(svc.photos||{})){
   if(typeof src!=='string'||!src.startsWith(imagePrefix))continue;
   const path=src.slice(imagePrefix.length);
   if(!path.startsWith(sessionUser.id+'/'))throw Error('Una fotografía de otro usuario no se puede descargar.');
   const {data,error}=await sdk().storage.from(PHOTO_BUCKET).download(path);
   if(error||!data)throw Error('No se pudo recuperar la fotografía '+key+' de Supabase Storage: '+(error?.message||'sin contenido'));
   svc.photos[key]=await asDataUri(data);
  }
  for(const a of svc.attachments||[]){
   if(!a?.remotePath)continue;
   if(!a.remotePath.startsWith(sessionUser.id+'/'))throw Error('Un adjunto pertenece a otra cuenta.');
   if(a.blobId && await window.MHSOffline?.getBlob?.(a.blobId))continue;
   const {data,error}=await sdk().storage.from(PHOTO_BUCKET).download(a.remotePath);
   if(error||!data)throw Error('No se pudo recuperar adjunto '+(a.name||a.id)+': '+(error?.message||'sin contenido'));
   if(!window.MHSOffline?.storeBlob)throw Error('IndexedDB de adjuntos no disponible.');
   a.blobId=await window.MHSOffline.storeBlob(data,{name:a.name||'Adjunto',type:a.type||data.type,serviceId:svc.id});
  }
 }
 return remote;
}

let captureJob=Promise.resolve();
function onLocalSave(s){
 if(suppressed)return;
 // Cola escrita en IndexedDB antes de cualquier envío. Nunca se envía durante el guardado local.
 const copy=typeof structuredClone==='function'?structuredClone(s):JSON.parse(JSON.stringify(s));
 captureJob=captureJob.catch(()=>{}).then(async()=>{
  const existing=await get('draft');
  const base=existing?.base??await get('head')??null;
  await set('draft',{id:uid(),base,state:copy,updatedAt:new Date().toISOString()});
  event('pendiente');
 }).catch(e=>event('error',{message:'No se pudo conservar la cola local: '+e.message}));
}
async function handleRecoveryReturn(){
 if(!recoveryReturn)return;
 recoveryNotice='Validando el enlace de recuperación con Supabase…';
 displayRecovery();
 try{
  const {data,error}=await sdk().auth.setSession(recoveryReturn);
  if(error)throw error;
  if(!data?.session?.user)throw Error('Supabase no confirmó la sesión de recuperación.');
  recoveryGranted=true;
  auto=false;
  recoveryNotice='Enlace validado. Introduce y confirma una contraseña nueva (mínimo 12 caracteres).';
 }catch(e){
  recoveryGranted=false;
  recoveryNotice='No se pudo validar el enlace: '+e.message+'. Solicita otro enlace desde Recuperar contraseña.';
 }finally{
  recoveryReturn.access_token='';recoveryReturn.refresh_token='';
  displayRecovery();
 }
}
function sdk(){
 if(!window.supabase?.createClient)throw Error('Supabase no está disponible. La aplicación local sigue funcionando.');
 if(!client){
  client=window.supabase.createClient(URL,KEY,{auth:{storageKey:'mhs-integracion-supabase-auth-v1',persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,flowType:'implicit'}});
  client.auth.onAuthStateChange((type)=>{
   if(type==='PASSWORD_RECOVERY'){
    recoveryGranted=true;auto=false;
    recoveryNotice='Enlace válido. Introduce la contraseña nueva y confirma el cambio.';
    setTimeout(displayRecovery,0);
   }
  });
 }
 return client;
}
async function login(email,password){
 if(!navigator.onLine)throw Error('Necesitas Internet para iniciar sesión por primera vez.');
 const {data,error}=await sdk().auth.signInWithPassword({email,password});
 if(error)throw error;
 sessionUser=data.user;event('sesion');return !!sessionUser;
}
async function who(){
 const {data,error}=await sdk().auth.getUser();if(error){sessionUser=null;return null;}sessionUser=data.user||null;
 if(sessionUser)await checkAccount();return sessionUser;
}
async function checkAccount(){
 const existing=await get('owner');
 if(existing&&existing!==sessionUser.id)throw Error('Este perfil ya contiene datos de otro usuario. No se permite mezclar cuentas.');
 if(!existing)await set('owner',sessionUser.id);
}
async function logout(){if(client)await client.auth.signOut();sessionUser=null;auto=false;event('sin-sesion');}
// Lectura verificable: nunca ocultar filas por un filtro silencioso.
// Incluye una consulta puntual por record_id cuando el dispositivo ya reconoció un envío.
function decodeVersion(row){
 let raw=row.data;
 if(typeof raw==='string'){
  try{raw=JSON.parse(raw)}catch{return {error:'JSON no válido en data'}}
 }
 if(!raw||typeof raw!=='object')return {error:'data no es un objeto'};
 const version=raw.version;
 const state=raw.state;
 if(typeof version!=='string'||!version.trim())return {error:'falta version en data'};
 if(!state||!Array.isArray(state.services))return {error:'state.services no es una lista'};
 if(String(row.record_id)!==version)return {error:'record_id no coincide con version'};
 return {item:{...row,version,parent:raw.parent??null,state}};
}
// V6: contrastar dos lecturas independientes. Si una omite una fila, se bloquea
// la publicación y se informa del ID exacto; nunca se considera nube compatible.
async function fetchPaged(makeQuery,label,orderField='created_at'){
 const rows=[];let page=0;
 while(true){
  const {data,error}=await makeQuery().order(orderField,{ascending:true}).range(page*500,(page+1)*500-1);
  if(error)throw Error('Fallo al leer '+label+': '+error.message);
  rows.push(...(data||[]));
  if(!data||data.length<500)break;
  if(++page>=10)throw Error('Demasiados registros en '+label+'. No continuar.');
 }
 return rows;
}
async function versions(){
 if(!await who())throw Error('Inicia sesión primero.');
 // Las versiones se consultan sin ordenar todo el JSON remoto en el servidor.
 // La lectura de control solo trae identificadores: evita descargar dos veces
 // las fotografías y los estados completos de todas las versiones.
 // Si superamos el límite de seguridad, DETENER: nunca tratar una lectura truncada
 // como un historial válido (podría sobrescribir cambios en otro dispositivo).
 const maxVersions=1000;
 const first=await sdk().from('app_data')
  .select('record_id,data,created_at,data_type,user_id')
  .eq('user_id',sessionUser.id).eq('data_type',NS).limit(maxVersions+1);
 if(first.error)throw Error('Fallo al leer versiones del piloto: '+first.error.message);
 const a=first.data||[];
 if(a.length>maxVersions)throw Error('Historial de versiones demasiado extenso. No sincronizar hasta optimizar la base de datos.');
 // Segunda comprobación limitada al mismo tipo de versión. La consulta anterior
 // barría también clientes y productos antiguos, pudiendo agotar el tiempo de SQL.
 const second=await sdk().from('app_data')
  .select('record_id,data_type,user_id').eq('user_id',sessionUser.id).eq('data_type',NS).limit(maxVersions+1);
 if(second.error)throw Error('Fallo al cotejar las versiones: '+second.error.message);
 const all=second.data||[];
 if(all.length>maxVersions)throw Error('Demasiados registros para verificar el historial. Sincronización detenida sin cambios.');
 const b=all.filter(row=>row.data_type===NS);
 const ids=rows=>new Set(rows.map(row=>String(row.record_id)));
 const ai=ids(a),bi=ids(b);
 const onlyA=[...ai].filter(id=>!bi.has(id));
 const onlyB=[...bi].filter(id=>!ai.has(id));
 if(onlyA.length||onlyB.length){
  throw Error('LECTURA INCONSISTENTE: la consulta filtrada devuelve '+a.length+
   ' versiones y la consulta general devuelve '+b.length+
   '. IDs discrepantes: '+[...onlyA,...onlyB].slice(0,5).join(', ')+
   '. No publiques ni descargues; revisa Supabase y conserva JSON.');
 }
 const parsed=[],rejected=[];
 for(const row of a){
  if(row.user_id!==sessionUser.id||row.data_type!==NS){
   rejected.push(String(row.record_id)+': propietario/tipo inesperado');continue;
  }
  const result=decodeVersion(row);
  if(result.error)rejected.push(String(row.record_id)+': '+result.error);
  else parsed.push(result.item);
 }
 if(rejected.length)throw Error('Versiones de prueba ilegibles: '+rejected.slice(0,5).join('; ')+'. No publiques ni descargues.');
 const localHead=await get('head');
 const draft=await get('draft');
 const checkIds=[localHead,draft?.base,draft?.id].filter(Boolean);
 // Incluso si ambos listados coinciden, verificar individualmente las referencias locales.
 for(const id of new Set(checkIds)){
  const {data:probe,error}=await sdk().from('app_data')
   .select('record_id,data,data_type,user_id').eq('record_id',id).limit(2);
  if(error)throw Error('No se pudo comprobar el ID '+id+': '+error.message);
  const row=(probe||[]).find(r=>String(r.record_id)===String(id));
  if(row&&row.user_id===sessionUser.id&&row.data_type===NS){
   const decoded=decodeVersion(row);
   if(decoded.error)throw Error('Registro '+id+' ilegible: '+decoded.error);
   if(!ai.has(String(id)))throw Error('LECTURA INCOMPLETA: Supabase devuelve el registro '+id+
    ' directamente, pero NO aparece en los listados ('+a.length+' versiones). No publiques ni descargues.');
  }else if(id===localHead){
   throw Error('El ID local reconocido '+id+' no se pudo consultar directamente. No publiques ni descargues.');
  }
 }
 const unique=ids(parsed);
 if(unique.size!==parsed.length)throw Error('IDs de versión duplicados. No publiques ni descargues.');
 return parsed;
}

function heads(list){
 const parents=new Set(list.map(x=>x.parent).filter(Boolean));
 return list.filter(x=>!parents.has(x.version));
}
async function inspect(){
 await captureJob;
 if(!navigator.onLine)throw Error('Sin Internet. Los cambios permanecen en el dispositivo.');
 const list=await versions(),h=heads(list),draft=await get('draft'),local= snapshot();
 const head=await get('head');
 let status='';
 if(h.length>1)status='CONFLICTO: existen varias versiones de nube. No se sobrescribirá ninguna.';
 else if(!h.length)status='No hay versiones del historial de sincronización para esta cuenta. Los datos antiguos de Supabase NO se han importado automáticamente.';
 else if(draft&&draft.base!==h[0].version)status='CONFLICTO: hay cambios locales y una versión de nube diferente. No se sobrescribirá nada.';
 else if(draft)status='Hay cambios locales pendientes; nube compatible.';
 else if(head===h[0].version)status='Copia publicada encontrada y verificada. Ordenador y nube están en la misma versión.';
 else if(!head&& !isEmpty(local))status='Datos locales sin vincular. Se requiere revisión manual antes de adoptar la nube.';
 else status='Hay una versión de nube disponible para descargar de forma segura.';
 const unresolved=await get('unverifiedPublish');
 if(unresolved)status='PUBLICACIÓN SIN VERIFICAR ('+unresolved.id+'). No publiques otra vez. '+status;
 const result={status,count:list.length,heads:h.length,remote:h.length===1?h[0]:null,draft:!!draft,localEmpty:isEmpty(local),localHead:head};
 event('inspeccion',{status});return result;
}
async function publish(){
 if(working)throw Error('Ya hay otra sincronización en curso.');
 working=true;
 try{
  await captureJob;
  const unresolved=await get('unverifiedPublish');
  if(unresolved)throw Error('Hay una publicación ya enviada sin verificar ('+unresolved.id+'). No se permite otra publicación.');
  const inspection=await inspect();
  if(inspection.heads>1)throw Error(inspection.status);
  const head=inspection.remote?.version||null;
  const acknowledged=await get('head')||null;
  const existing=await get('draft');
  if(head!==acknowledged)throw Error('La nube ha cambiado o aún no está vinculada. No se permite publicar hasta revisar los datos remotos.');
  let toSend=existing;
  if(!toSend){
   if(head)return {message:'No hay cambios pendientes.'};
   const local=snapshot();if(!local)throw Error('No hay datos locales.');
   toSend={id:uid(),base:null,state:local,updatedAt:new Date().toISOString()};
   await set('draft',toSend);
  }
  if(!navigator.onLine)throw Error('Sin Internet; se conserva la copia pendiente.');
  const prepared=await cloudReadyState(toSend.state);
  const payload={version:toSend.id,parent:head,state:prepared.cloud,createdAt:new Date().toISOString()};
  // Sin un bucket verificado no publicar referencias a blobs locales que otros equipos no pueden abrir.
  const missingAttachments=[];
  for(const sheet of payload.state.services||[]){
   for(const attachment of sheet.attachments||[]){
    if(attachment.blobId&&!attachment.remotePath&&!attachment.url)missingAttachments.push(attachment.name||attachment.id||'archivo');
   }
  }
  if(missingAttachments.length)throw Error('Hay '+missingAttachments.length+' archivos solo locales. Sin Supabase Storage comprobado no se publicara una copia incompleta.');
  // Sin límite artificial de 3,5 MB: el servidor valida el tamaño real de la petición.
  // IndexedDB conserva la copia local incluso si Supabase rechaza una petición grande.
  const {error}=await sdk().from('app_data').insert({user_id:sessionUser.id,data_type:NS,record_id:toSend.id,data:payload});
  if(error)throw error;
  // Solo reconocer el envío tras comprobar contenido y estructura de la fila recuperada.
  const {data:verify,error:verifyError}=await sdk().from('app_data').select('record_id,data').eq('user_id',sessionUser.id).eq('data_type',NS).eq('record_id',toSend.id).maybeSingle();
  if(verifyError||!verify)throw Error('No se ha podido confirmar la escritura. Conservar copia local; no repetir a ciegas.');
  const checked=decodeVersion(verify);
  if(checked.error||checked.item.version!==toSend.id)throw Error('La copia se recibió, pero su lectura no coincide: '+(checked.error||'ID diferente')+'. No repetir el envío.');
  // Guardar un recibo local permanente antes del listado; ante un error no reinsertar.
  await set('unverifiedPublish',{id:toSend.id,parent:head,createdAt:new Date().toISOString()});
  let check;
  try{
   // Comprobar la versión publicada sin dar por verificado un listado incompleto.
   const published=await versions();
   const h=heads(published);
   if(h.length!==1||h[0].version!==toSend.id)
    throw Error('La versión escrita no aparece como cabeza única de la nube.');
   check={ok:true};
  }catch(e){
   throw Error('Publicación guardada con ID '+toSend.id+', pero sin verificar el historial: '+e.message+
    ' NO REPITAS el envío. Conserva JSON y comprueba la tabla de Supabase.');
  }
  if(check.ok){
   await window.MHSApp?.registerCloudFiles?.(prepared.updates);
   await set('head',toSend.id);
   const latest=await get('draft');if(latest?.id===toSend.id)await set('draft',null);
   await set('unverifiedPublish',null);
  }
  event('publicado');return {message:'Nueva versión publicada y verificada. No se han modificado los registros anteriores.'};
 }finally{working=false;}
}
async function adopt(){
 if(working)throw Error('Sincronización ocupada.');
 working=true;
 try{
  if(await get('unverifiedPublish'))throw Error('Hay una publicación anterior sin verificar. No descargues ni sobrescribas datos.');
  const r=await inspect();
  if(r.heads!==1||!r.remote)throw Error('No hay una única versión segura que adoptar.');
  if(r.draft)throw Error('Hay cambios locales pendientes. Exporta su JSON y resuelve el conflicto antes de continuar.');
  const local=snapshot();
  if(!r.localEmpty&&r.localHead!==r.remote.version){
   const all=await versions(),byId=new Map(all.map(x=>[x.version,x]));let ancestor=r.remote.version;
   while(ancestor&&ancestor!==r.localHead)ancestor=byId.get(ancestor)?.parent||null;
   if(!r.localHead||ancestor!==r.localHead)throw Error('Este dispositivo tiene datos no vinculados o divergentes. Exporta JSON y comprueba las diferencias antes de adoptar la nube.');
  }
  suppressed=true;
  try{const applied=await window.MHSApp.applyRemoteState(r.remote.state,{source:'supabase'});if(applied!==true)throw Error('La app no confirmó que guardó los datos recibidos.');await set('head',r.remote.version);}finally{suppressed=false;}
  event('actualizado');return {message:'Versión recibida y guardada localmente.'};
 }finally{working=false;}
}
// Recuperación manual excepcional: adopta la versión remota SOLO tras respaldo y confirmación.
// No elimina IndexedDB, ni cookies, ni historial, ni filas de Supabase.
async function resolveLocalConflict(){
 if(working)throw Error('Hay otra operación de sincronización en curso.');
 working=true;
 auto=false;
 try{
  await captureJob;
  if(!navigator.onLine)throw Error('Sin Internet. Se conservan todos los datos locales.');
  if(await get('unverifiedPublish'))throw Error('Existe una publicación sin verificar. Recuperación bloqueada.');
  if(await get('recoveryCheckpoint'))throw Error('Ya existe un punto de recuperación previo. No repitas el proceso hasta revisarlo.');
  // Verificar cuenta, historial íntegro, único extremo y estado local.
  const list=await versions(),h=heads(list),draft=await get('draft'),localHead=await get('head');
  if(h.length!==1)throw Error('La nube no tiene una única versión final; no se modifica nada.');
  if(!draft)throw Error('No existe un borrador conflictivo. Utiliza Comprobar nube.');
  if(draft.base===h[0].version)throw Error('No hay divergencia de base; utiliza el procedimiento normal.');
  if(!localHead||draft.base!==localHead)throw Error('La base del borrador no coincide con el ID local reconocido. Revisión manual necesaria.');
  if(!list.some(v=>v.version===localHead))throw Error('La base del dispositivo no existe en el historial verificado.');
  const local=snapshot();
  if(!local||!sameState(local,draft.state))throw Error('Los datos actuales no coinciden con el borrador pendiente. Guarda/exporta JSON y revisa antes de continuar.');
  if(!window.MHSApp?.applyRemoteState)throw Error('La aplicación no ofrece aplicación segura del estado remoto.');
  // app.js utiliza localStorage como almacenamiento principal y MHSOffline como respaldo.
  if(!window.localStorage)throw Error('No se puede verificar el almacenamiento local.');
  const remoteVersion=h[0].version;
  // No se ejecuta esta función sin haber conservado antes el JSON externo.
  const answer=prompt('RECUPERACIÓN MANUAL DE PRUEBAS\n\nSe sustituirá SOLO el estado local de este dispositivo por el de Supabase.\nEl JSON externo de la tablet debe estar descargado y conservado.\nNo se alterará la nube ni el segundo iMac.\n\nEscribe exactamente RECUPERAR TABLET para confirmar:');
  if(answer!=='RECUPERAR TABLET')return {message:'Operación cancelada. No se ha cambiado nada.'};
  // Repetir las comprobaciones después de la confirmación: la nube podría cambiar.
  await captureJob;
  const again=await versions(),last=heads(again),nowDraft=await get('draft');
  if(last.length!==1||last[0].version!==remoteVersion||!nowDraft||nowDraft.id!==draft.id||
     !sameState(snapshot(),local))throw Error('Los datos cambiaron durante la confirmación. No se modifica nada.');
  // Copia de recuperación adicional en el almacén AISLADO, antes de tocar el estado.
  const checkpoint={madeAt:new Date().toISOString(),localHead,draft,localState:local,
    remoteVersion,phase:'prepared'};
  await set('recoveryCheckpoint',checkpoint);
  suppressed=true;
  try{
   const applied=await window.MHSApp.applyRemoteState(last[0].state,{source:'supabase'});
   if(applied!==true||!sameState(snapshot(),last[0].state))
     throw Error('La lectura local después de aplicar la nube no coincide.');
   // app.js puede ignorar un fallo de almacenamiento; comprobar persistencia real.
   const saved=window.localStorage.getItem('hmsarbide_sync_piloto_v1_local');
   if(!saved||!sameState(JSON.parse(saved),last[0].state))
     throw Error('La copia nueva no quedó verificada en localStorage.');
   if(window.MHSOffline?.loadState){
     const offline=await window.MHSOffline.loadState();
     if(!offline||!sameState(offline,last[0].state))
       throw Error('La copia nueva no quedó verificada en el almacenamiento offline.');
   }
   await setMany([['head',remoteVersion],['draft',null],
     ['recoveryCheckpoint',{...checkpoint,phase:'completed'}]]);
  }catch(error){
   // No se elimina el punto de recuperación; queda para revisión si algo falla.
   try{
    const restored=await window.MHSApp.applyRemoteState(local,{source:'supabase'});
    if(restored!==true||!sameState(snapshot(),local))throw Error('No se pudo restaurar el estado en memoria.');
    await setMany([['head',localHead],['draft',draft],
      ['recoveryCheckpoint',{...checkpoint,phase:'failed-restored',reason:String(error.message||error)}]]);
   }catch(restoreError){
    throw Error('RECUPERACIÓN INCOMPLETA. Detén las pruebas. Conserva el JSON externo y el navegador abierto. '+restoreError.message);
   }
   throw Error('No se completó la recuperación; se intentó restaurar el estado original. '+error.message);
  }finally{suppressed=false;}
  event('actualizado');
  return {message:'La tablet ha adoptado la versión de Supabase. Punto de recuperación local conservado. Comprueba nube sin cambios.'};
 }finally{working=false;}
}
// Lectura de datos LEGADOS del proyecto original, separada de las versiones nuevas.
// Solo SELECT bajo las políticas RLS de Supabase. Nunca escribe ni elimina esas filas.
const LEGACY_TYPES={clients:'clients',products:'products',invoices:'invoices',budgets:'budgets'};
let legacyLoaded=false, legacyCache=null;
function parseJSONField(value){
 if(typeof value==='string'){try{return JSON.parse(value)}catch{throw Error('Hay un registro antiguo con JSON ilegible; no se sincroniza para evitar pérdidas.')}}
 return value;
}
function arrayFromLegacy(value,kind,recordId){
 value=parseJSONField(value);
 if(value==null)return [];
 if(Array.isArray(value))return value;
 if(typeof value==='object'){
  for(const k of [kind,'items','records','value','data'])if(Array.isArray(value[k]))return value[k];
  if(value.id||value.name||value.number)return [value];
  if(Object.keys(value).length===0)return [];
 }
 throw Error('No reconozco el formato antiguo de '+kind+' ('+recordId+'). No se enviarán cambios hasta revisarlo.');
}
function legacySheet(value,row){
 value=parseJSONField(value);
 if(value&&typeof value==='object'&&value.sheet)value=value.sheet;
 if(!value||typeof value!=='object'||Array.isArray(value)||!value.type)
  throw Error('Formato de hoja antigua desconocido ('+row.id+'); sincronización detenida para protegerla.');
 const sheet={...value,id:value.id||String(row.id)};
 if(!sheet.updatedAt)sheet.updatedAt=row.updated_at||sheet.modified||sheet.createdAt||'1970-01-01T00:00:00Z';
 if(!sheet.client||typeof sheet.client!=='object')sheet.client={};
 // El editor actual usa "madera" donde el editor anterior usaba "insitu".
 if(sheet.type==='insitu'){
  sheet.type='madera';
  const d=sheet.data||{};sheet.data={...d,woodTreatment:Array.isArray(d.treat)?d.treat.join(' + '):(d.woodTreatment||''),woodArea:d.area||d.woodArea||'',woodObs:d.observations||d.woodObs||''};
 }
 if(!['madera','ddd','autoclave','mobiliario','termitas'].includes(sheet.type))
  throw Error('Tipo de hoja antigua no reconocido ('+sheet.type+'). No se descarta.');
 return sheet;
}
async function fetchLegacy(){
 if(!sessionUser)throw Error('Sesión no disponible para recuperar los datos antiguos.');
 const result={services:[],clients:[],products:[],invoices:[],budgets:[],company:{}};
 // Consultar TODAS las páginas: no interpretar errores o RLS como «cero registros».
 const old=await fetchPaged(()=>sdk().from('app_data')
  .select('record_id,data_type,data,created_at,user_id').eq('user_id',sessionUser.id).neq('data_type',NS),'app_data antigua');
 for(const row of old){
  const kind=LEGACY_TYPES[row.data_type];
  if(kind){
   const values=arrayFromLegacy(row.data,kind,row.record_id);
   for(const obj of values){
    if(!obj||typeof obj!=='object')throw Error('Registro de '+kind+' inválido en Supabase.');
    const item={...obj};
    if(!item.id)item.id=String(row.record_id)+(values.length===1?'':'_'+result[kind].length);
    if(!item.updatedAt)item.updatedAt=row.created_at||'1970-01-01T00:00:00Z';
    result[kind].push(item);
   }
  }
  if(row.data_type==='config'||row.data_type==='company'){
   const raw=parseJSONField(row.data);
   if(raw&&typeof raw==='object'&&!Array.isArray(raw)){
    const co=raw.company&&typeof raw.company==='object'?raw.company:raw;
    // No convertir claves técnicas o ajustes en campos de empresa.
    for(const key of ['name','commercialName','taxId','address','postalCode','province','phone','email','registration','directorName','directorSurname','logo','directorSignature']){
     if(co[key]!==undefined&&co[key]!==null&&co[key]!=='')result.company[key]=co[key];
    }
   }
  }
 }
 const sheets=await fetchPaged(()=>sdk().from('service_sheets')
  .select('id,user_id,data,updated_at').eq('user_id',sessionUser.id),'service_sheets antigua','updated_at');
 for(const row of sheets)result.services.push(legacySheet(row.data,row));
 return result;
}
function mergeLegacyIntoCurrent(legacy){
 const original=snapshot();
 if(!original)throw Error('No se puede leer el estado de MHSARBIDE.');
 const merged={...original};let additions=0;
 for(const kind of ['clients','products','invoices','budgets','services']){
  const current=Array.isArray(original[kind])?original[kind]:[];
  const byId=new Map(current.filter(x=>x?.id).map(x=>[String(x.id),x]));
  for(const x of legacy[kind]){
   const key=String(x.id),exists=byId.get(key);
   if(!exists){byId.set(key,x);additions++;}
   // La versión normalizada de sincronización tiene prioridad para IDs ya presentes.
  }
  merged[kind]=[...byId.values()];
 }
 const co={...legacy.company,...(original.company||{})};
 for(const [k,v] of Object.entries(legacy.company))if(merged.company?.[k]==null||merged.company[k]==='')co[k]=v;
 merged.company=co;
 return {merged,additions,changed:!sameState(original,merged)};
}
async function integrateLegacy(){
 if(legacyLoaded)return;
 // No marcar como «integrado» si la lectura de RLS falla.
 await window.MHSApp?.ready;
 const legacy=await fetchLegacy();legacyCache=legacy;
 const result=mergeLegacyIntoCurrent(legacy);
 if(result.changed){
  suppressed=true;
  try{if(await window.MHSApp?.applyRemoteState?.(result.merged,{source:'supabase'})!==true)
   throw Error('No se han podido integrar los registros antiguos en el almacenamiento del dispositivo.');}
  finally{suppressed=false;}
  const current=await get('draft');
  const base=current?.base??await get('head')??null;
  await set('draft',{id:uid(),base,state:snapshot(),updatedAt:new Date().toISOString()});
 }
 legacyLoaded=true;
 event('legado',{services:legacy.services.length,clients:legacy.clients.length,products:legacy.products.length});
}
// Sincronización automática: sesión persistente y un único historial por usuario.
// Los estados nuevos se mezclan por ID, sin sobrescribir las tablas antiguas.
let authPanel=null,authStatus=null,autoBusy=false,lastError='',bootstrapDone=false;
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
function showStatus(message,problem=false){
 lastError=problem?String(message):'';
 event(problem?'error':'automatico',{message});
 if(authStatus)authStatus.textContent=message;
 const indicator=document.getElementById('hms-sync-indicator');
 if(indicator){indicator.textContent=problem?'⚠ Sincronización pendiente':(sessionUser?'● Conectado':'● Sin conectar');indicator.title=message;}
}
function showLogin(message=''){
 if(authPanel)authPanel.hidden=false;
 document.body.classList.add('hms-auth-required');
 if(message)showStatus(message,true);
}
function hideLogin(){if(authPanel)authPanel.hidden=true;document.body.classList.remove('hms-auth-required');}
async function adoptMerged(remote){
 // applyRemoteState une por ID y devuelve true tras persistir los datos.
 // La versión remota puede coexistir con nuevos registros locales que aún no se han enviado.
 suppressed=true;
 try{
  const expanded=await restoreRemoteFiles(remote.state);
  const ok=await window.MHSApp?.applyRemoteState?.(expanded,{source:'supabase'});
  if(ok!==true)throw Error('No se pudieron guardar los datos recibidos de Supabase.');
  await set('head',remote.version);
 }finally{suppressed=false;}
 const merged=snapshot();
 if(!sameState(merged,remote.state)){
  await set('draft',{id:uid(),base:remote.version,state:merged,updatedAt:new Date().toISOString()});
 }else{
  await set('draft',null);
 }
}
// Reanudar SIN DUPLICAR tras una interrupción entre la escritura y la
// confirmación. La prueba directa valida el ID, propietario, contenido y padre.
// El control del historial comprueba que NO haya ramas simultáneas.
// Si falla cualquier consulta, se conserva el bloqueo y la copia local.
async function reconcileUnverified(){
 const receipt=await get('unverifiedPublish');
 if(!receipt)return false;
 if(!sessionUser?.id)throw Error('Es necesario iniciar sesión para verificar el envío pendiente.');
 if(!navigator.onLine)throw Error('Sin conexión: se conserva la publicación pendiente.');
 const {data,error}=await sdk().from('app_data')
  .select('record_id,data,data_type,user_id')
  .eq('user_id',sessionUser.id).eq('data_type',NS).eq('record_id',receipt.id).maybeSingle();
 if(error||!data)throw Error('No se puede confirmar todavía la publicación pendiente: '+(error?.message||'registro ausente')+'. No se reenvía.');
 const decoded=decodeVersion(data);
 if(decoded.error||decoded.item.version!==receipt.id||
   (decoded.item.parent||null)!==(receipt.parent||null))
  throw Error('La publicación pendiente no coincide con el registro remoto. Sincronización detenida, sin sobrescribir.');
 const list=await versions();
 const ends=heads(list);
 if(ends.length!==1||ends[0].version!==receipt.id)
  throw Error('La publicación pendiente existe, pero no es la única versión final de la nube. No se reenvía.');
 const draft=await get('draft');
 const currentHead=await get('head');
 if(currentHead && currentHead!==receipt.parent && currentHead!==receipt.id)
  throw Error('El historial local no corresponde a la publicación pendiente. No se altera.');
 let nextDraft=draft;
 if(draft?.id===receipt.id)nextDraft=null;
 else if(draft && draft.base===receipt.parent)
  nextDraft={...draft,base:receipt.id}; // Cambios posteriores siguen pendientes.
 else if(draft && draft.base!==receipt.id)
  throw Error('Hay cambios locales con una base incompatible. No se sobrescribirán.');
 await setMany([['head',receipt.id],['draft',nextDraft],['unverifiedPublish',null]]);
 event('verificado',{message:'Publicación anterior recuperada y verificada automáticamente.'});
 return true;
}
async function automaticSync(){
 if(!auto||autoBusy||working||recoveryGranted||!navigator.onLine)return;
 autoBusy=true;
 try{
  await window.MHSApp?.ready;
  await captureJob;
  if(!sessionUser){if(!await who()){showLogin();return;}}
  // Una interrupción tras la escritura no requiere repetir el envío.
  // Se verifica primero el registro conocido y se recupera su confirmación.
  if(await get('unverifiedPublish'))await reconcileUnverified();
  const all=await versions(),ends=heads(all);
  if(ends.length>1)throw Error('Hay versiones simultáneas en Supabase. Se han detenido los envíos para evitar pérdidas.');
  const remote=ends[0]||null;
  const known=await get('head');
  let pending=await get('draft');
  if(remote){
   if(known!==remote.version || (pending&&pending.base!==remote.version)){
    // Nunca se descartan datos de un dispositivo: se combinan antes de publicar.
    await adoptMerged(remote);
    pending=await get('draft');
   }else if(!pending && !sameState(snapshot(),remote.state)){
    // Detectar cambios locales sin registrar realizados antes de cargar el módulo.
    await set('draft',{id:uid(),base:remote.version,state:snapshot(),updatedAt:new Date().toISOString()});
    pending=await get('draft');
   }
  }else{
   if(known)throw Error('El historial remoto que conocía este dispositivo no está disponible. No se enviarán datos.');
   if(!pending && !isEmpty(snapshot())){
    await set('draft',{id:uid(),base:null,state:snapshot(),updatedAt:new Date().toISOString()});
    pending=await get('draft');
   }
  }
  await integrateLegacy();
  pending=await get('draft');
  if(pending){
   // publish() comprueba la cabeza y verifica el registro tras insertarlo.
   await publish();
  }
  bootstrapDone=true;
  hideLogin();
  showStatus('Conectado a Supabase. Los cambios se sincronizan automáticamente.');
 }catch(e){
  showStatus(e?.message||String(e),true);
  // Una incidencia de sincronización no revoca la sesión ya autenticada.
  // No se reenvían cambios sin verificar ni se modifica el historial remoto.
  if(sessionUser)hideLogin();else showLogin();
 }finally{autoBusy=false;}
}
function requestSync(){if(auto)void automaticSync();}
function onAuthenticated(){
 auto=true;bootstrapDone=false;
 // El acceso depende de la autenticación, no de publicar/descargar datos.
 hideLogin();
 showStatus('Sesión iniciada. Comprobando sincronización…');
 requestSync();
}
function initUI(){
 const indicator=document.createElement('button');
 indicator.id='hms-sync-indicator';indicator.type='button';indicator.className='hms-connection';
 indicator.textContent='● Conectando…';indicator.title='Estado de conexión';
 document.querySelector('.topactions')?.prepend(indicator);
 const panel=document.createElement('section');panel.id='hms-auth';panel.setAttribute('role','dialog');
 panel.setAttribute('aria-label','Acceso a MHSARBIDE');panel.className='hms-auth-panel';
 panel.innerHTML=`<div class="hms-login-card"><h1>MHSARBIDE</h1><p>Accede para trabajar con tus datos de Supabase.</p>
 <label>Correo electrónico<input id="hss-email" type="email" autocomplete="username" inputmode="email"></label>
 <label>Contraseña<input id="hss-password" type="password" autocomplete="current-password"></label>
 <button id="hss-login" type="button" class="btn">Iniciar sesión</button>
 <button id="hss-forgot" type="button" class="btn secondary">Recuperar contraseña</button>
 <p id="hss-status" role="status" aria-live="polite"></p></div>`;
 document.body.append(panel);authPanel=panel;showLogin();
 const $=id=>panel.querySelector('#'+id);authStatus=$('hss-status');
 $('hss-login').onclick=async()=>{
  const btn=$('hss-login');btn.disabled=true;
  try{await login($('hss-email').value.trim(),$('hss-password').value);$('hss-password').value='';onAuthenticated();}
  catch(e){showLogin('No se pudo iniciar sesión: '+e.message);}finally{btn.disabled=false;}
 };
 $('hss-password').addEventListener('keydown',e=>{if(e.key==='Enter')$('hss-login').click();});
 $('hss-forgot').onclick=async()=>{
  try{authStatus.textContent=await sendRecovery($('hss-email').value.trim());}
  catch(e){authStatus.textContent=e.message;}
 };
 indicator.onclick=()=>{
  if(lastError)alert('Sincronización pendiente: '+lastError+'\nLos datos locales se conservan.');
  else if(!sessionUser)showLogin();
  else if(confirm('¿Quieres cerrar tu sesión de MHSARBIDE en este dispositivo?')){
   void logout().then(()=>showLogin('Sesión cerrada.')).catch(e=>showStatus(e.message,true));
  }
 };
 const rec=document.createElement('section');rec.className='hms-recovery';rec.hidden=true;
 rec.setAttribute('role','dialog');rec.setAttribute('aria-label','Restablecer contraseña');
 rec.innerHTML=`<div class="hms-login-card"><h2>Recuperar contraseña</h2><p id="hss-rec-message" role="status"></p>
 <div id="hss-rec-fields" hidden><label>Contraseña nueva (mínimo 12 caracteres)<input id="hss-rec-new" type="password" minlength="12" autocomplete="new-password"></label>
 <label>Repetir contraseña<input id="hss-rec-confirm" type="password" minlength="12" autocomplete="new-password"></label>
 <button id="hss-rec-submit" class="btn">Guardar nueva contraseña</button></div>
 <button id="hss-rec-close" class="btn secondary">Cerrar</button></div>`;
 document.body.append(rec);
 const r=id=>rec.querySelector('#'+id);
 recoveryUI={panel:rec,area:r('hss-rec-fields'),status:r('hss-rec-message')};
 r('hss-rec-close').onclick=()=>{rec.hidden=true;if(!sessionUser)showLogin();};
 r('hss-rec-submit').onclick=async()=>{try{await finishRecovery(r('hss-rec-new').value,r('hss-rec-confirm').value);r('hss-rec-new').value='';r('hss-rec-confirm').value='';}catch(e){r('hss-rec-message').textContent=e.message;}};
 try{sdk();}catch(e){showLogin('No se pudo iniciar Supabase: '+e.message);return;}
 if(recoveryReturn||recoveryReturnError){
  if(recoveryReturnError){recoveryNotice='El enlace ha caducado o no es válido. Solicita uno nuevo.';displayRecovery();}
  if(recoveryReturn)void handleRecoveryReturn();
 }
 // SDK puede tardar en restaurar la sesión: no declarar vacío el estado mientras tanto.
 void (async()=>{
  try{
   const user=await who();
   if(user&&!recoveryReturn&&!recoveryGranted)onAuthenticated();
   else if(!recoveryReturn)showLogin();
  }catch(e){showLogin('No se pudo comprobar la cuenta: '+e.message);}
 })();
}
window.addEventListener('online',requestSync);
window.addEventListener('focus',requestSync);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)requestSync();});
window.addEventListener('hms-sync-status',e=>{if(e.detail.name==='pendiente')requestSync();});
timer=setInterval(requestSync,15000);
window.HMSSupabasePilot={onLocalSave,login,logout,inspect,publish,adopt,who,sendRecovery,requestSync};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initUI);else initUI();
})();
