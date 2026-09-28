import {Room} from 'livekit-client';
import {LiveApi, friendlyError} from '../../site/src/live-api.js';
import {createPartyApi} from '../../site/src/party-api.js';
import {createPartyGrid} from '../../site/src/party-grid.js';
import {loadOrCreatePartyBrowserKey} from '../../site/src/party-names.js';
import '../../site/styles/party-room.css';
import {createPartyHost, setPartyHostAvailability} from './party-host.js';
import {createPartyMediaBridge} from './party-media.js';
import {ProgramStream} from './program-stream.js';
import {StudioRoomController, PrivateCallController} from './room-controller.js';

const $ = id => document.getElementById(id);
const api=new LiveApi();
let bootstrap, media, controller, privateCall, busy=false, camera=false, facingMode='user', wakeLock, pollTimer, closing=false;
let partyApi, partyHost, partyGrid, partyGridIdentity='', partyAvailability=false;
const labels={OFFLINE:'OFF AIR',CONNECTING:'SE CONECTEAZĂ',LIVE:'● LIVE',RECONNECTING:'RECONECTARE',PRIVATE_STANDBY:'PAUZĂ PRIVATĂ',UNAVAILABLE:'INDISPONIBIL'};
function message(text,error=false) { $('message').textContent=text; $('message').classList.toggle('error',error); }
function refreshControls() {
  const active=!!controller?.room, ready=media?.isReady();
  const unlocked=bootstrap && (bootstrap.remembered || bootstrap.recentReauth);
  $('btnStartCam').disabled=busy || camera || !unlocked;
  $('on-air').disabled=busy || !ready || active || !unlocked;
  $('off-air').disabled=busy || (!active && !controller?.grant);
  $('flip').disabled=busy || !camera;
  $('retry-cut').disabled=busy || !camera;
  $('stop-camera').disabled=busy || !camera || active;
  if($('party-open')) $('party-open').disabled=busy || !ready || !partyAvailability || ['opening','open','reconnecting'].includes(partyHost?.state.status);
}
async function requestWakeLock() {
  if(document.visibilityState!=='visible' || !controller?.room) return;
  try { if(!wakeLock || wakeLock.released) wakeLock=await navigator.wakeLock?.request('screen'); } catch { /* explanatory UI remains */ }
}
function state(value,detail) {
  $('state').textContent=labels[value] || value; $('state').dataset.state=value;
  if(detail) message(detail);
  else if(value==='LIVE') message('Ești în direct. Pe site ajunge imaginea din previzualizare și microfonul tău.');
  else if(value==='PRIVATE_STANDBY') message('Publicul vede „Revin imediat” fără sunet. Conversația este separată.');
  refreshControls();
  if(['LIVE','PRIVATE_STANDBY'].includes(value)) requestWakeLock();
  else if(value==='OFFLINE') { wakeLock?.release().catch(()=>{}); wakeLock=null; }
}
async function run(action) {
  if(busy) return;
  busy=true; refreshControls();
  try { await action(); }
  catch(error) {
    message(error.message==='CAMERA_NOT_READY' ? 'Așteaptă decuparea fundalului sau apasă Reîncearcă decuparea.' : friendlyError(error),true);
    if(error.code==='REAUTH_REQUIRED') { $('unlock').hidden=false; $('password').focus(); }
    if([401,403].includes(error.status) && !['REAUTH_REQUIRED','INVALID_PASSWORD'].includes(error.code)) await shutdown();
  } finally { busy=false; refreshControls(); }
}
function partyGridProxy() {
  const methods=['applyRoster','attachTrack','detachTrack','setTrackState','setConnectionState','setConnectionQuality','setSpeaking','remove','clear'];
  return Object.fromEntries(methods.map(method=>[method,(...args)=>partyGrid?.[method]?.(...args)]));
}
function resetPartyGrid(identity='') {
  $('party-grid').replaceChildren();
  partyGridIdentity=identity;
  partyGrid=createPartyGrid({root:$('party-grid'),localIdentity:identity,onRemove:memberOrIdentity=>{
    const participant=partyHost?.state.participants.find(value=>value.identity===memberOrIdentity || value.memberId===memberOrIdentity);
    if(participant?.memberId) run(()=>partyHost.remove(participant.memberId));
  }});
}
function renderParty(state=partyHost?.state) {
  if(!state) return;
  if(state.identity && state.identity!==partyGridIdentity) resetPartyGrid(state.identity);
  $('party-occupancy').textContent=`${state.occupancy}/${state.capacity}`;
  $('party-open').disabled=busy || !media?.isReady() || ['opening','open','reconnecting'].includes(state.status);
  $('party-close').disabled=busy || !state.sessionId;
  $('party-controls').hidden=!['open','reconnecting'].includes(state.status);
  $('party-microphone').setAttribute('aria-pressed',String(state.microphoneEnabled));
  $('party-camera').setAttribute('aria-pressed',String(state.cameraEnabled));
  $('party-confirm').hidden=!state.confirmationRequired;
  const messages={closed:'Camera cu invitați este închisă.',opening:'Se deschide camera cu invitați…',open:'Camera este deschisă pentru cereri.',reconnecting:'Se reface legătura camerei…',error:state.message || 'Camera cu invitați nu răspunde.'};
  $('party-status').textContent=messages[state.status] || '';
  const rows=state.requests.map(request=>{
    const card=document.createElement('div'); card.className='request party-request';
    const name=document.createElement('span'); name.textContent=request.displayName;
    const countdown=document.createElement('small'); countdown.textContent=`${request.remainingSeconds}s`;
    const accept=document.createElement('button'); accept.type='button'; accept.className='primary'; accept.textContent='Acceptă'; accept.disabled=state.acceptDisabled;
    accept.addEventListener('click',()=>run(()=>partyHost.accept(request.requestId)));
    const decline=document.createElement('button'); decline.type='button'; decline.textContent='Respinge';
    decline.addEventListener('click',()=>run(()=>partyHost.decline(request.requestId)));
    card.append(name,countdown,accept,decline); return card;
  });
  if(!rows.length) { const empty=document.createElement('p'); empty.className='empty'; empty.textContent='Nicio cerere momentan.'; rows.push(empty); }
  $('party-requests').replaceChildren(...rows);
}
async function ensurePartyStudio() {
  const browserKey=loadOrCreatePartyBrowserKey(localStorage);
  if(!partyApi) partyApi=createPartyApi({csrf:bootstrap.csrf_token,browserKey});
  let status;
  try { status=await partyApi.adminAvailability(); }
  catch { status={enabled:false}; }
  partyAvailability=status.enabled===true;
  setPartyHostAvailability({enabled:partyAvailability,panel:$('party-panel'),legacyPanel:$('legacy-private-panel')});
  if(!partyAvailability || partyHost) return;
  resetPartyGrid();
  partyHost=createPartyHost({
    api:partyApi,
    grid:partyGridProxy(),
    roomFactory:options=>new Room(options),
    mediaBridge:createPartyMediaBridge({programStream:media}),
    onState:renderParty,
  });
  renderParty();
}
function createStudio() {
  media=new ProgramStream({profile:bootstrap.profile,onStatus:(event)=>{
    if(typeof event==='string') message(event);
    else if(event?.message) message(event.message,event.code==='SEGMENTATION_UNAVAILABLE');
    refreshControls();
  }});
  media.programCanvas.id='stage'; media.programCanvas.setAttribute('aria-label','Previzualizarea emisiei');
  $('stage').replaceWith(media.programCanvas);
  media.setLogo($('logo').value);
  controller=new StudioRoomController({api,media,onState:state});
  privateCall=new PrivateCallController({controller,api,media,onState:state,video:$('guest-video'),soundButton:$('guest-sound')});
  $('profile').textContent=bootstrap.profile==='540p24'?'540p · 24 fps':'720p · 24 fps';
}
function renderRequests(rows=[]) {
  const requests=rows.filter(row=>row.state==='waiting');
  $('request-count').textContent=requests.length;
  const nodes=requests.map(row=>{
    const card=document.createElement('div'); card.className='request';
    const name=document.createElement('span'); name.textContent=row.name || 'Invitat';
    const accept=document.createElement('button'); accept.className='primary'; accept.textContent='Acceptă';
    accept.disabled=!controller?.room || controller.mode!=='LIVE' || !!privateCall?.id;
    accept.addEventListener('click',()=>run(async()=>{
      try { await privateCall.accept(row.id); }
      finally { $('private-call').hidden=!privateCall.id; $('recover').hidden=!privateCall.id || !!privateCall.room; }
      await poll();
    }));
    const decline=document.createElement('button'); decline.textContent='Refuză';
    decline.addEventListener('click',()=>run(async()=>{ await api.call('/api/admin/live/private/decline',controller.bound({id:row.id})); await poll(); }));
    card.append(name,accept,decline); return card;
  });
  if(!nodes.length) { const empty=document.createElement('p'); empty.className='empty'; empty.textContent='Nicio cerere momentan.'; nodes.push(empty); }
  $('requests').replaceChildren(...nodes);
}
async function poll() {
  clearTimeout(pollTimer);
  if(closing) return;
  try {
    bootstrap=await api.call('/api/admin/live/bootstrap');
    api.csrf=bootstrap.csrf_token;
    $('unlock').hidden=!!(bootstrap.remembered || bootstrap.recentReauth);
    if(!media) { createStudio(); state(bootstrap.state); message('Pornește camera, verifică imaginea, apoi apasă ON AIR.'); }
    await ensurePartyStudio();
    renderRequests(bootstrap.requests);
    if(controller.room && controller.mode==='PRIVATE_STANDBY' && privateCall.id && !bootstrap.activePrivate) {
      await privateCall.dispose(); $('recover').hidden=false;
      message('Invitatul a încheiat apelul. Apasă Revenire LIVE când ești pregătit.');
    }
    if(bootstrap.state==='PRIVATE_STANDBY' && !controller.room) {
      $('recover').hidden=false;
      message('O pauză privată a rămas deschisă. Pornește camera, reconectează studioul, apoi încheie pauza.');
    }
    refreshControls();
  } catch(error) {
    message(friendlyError(error),true);
    if([401,403].includes(error.status)) { await shutdown(); location.assign('/admin/?next=live-studio'); return; }
  }
  if(!closing) pollTimer=setTimeout(poll,5000);
}
$('unlock-form').addEventListener('submit',event=>{event.preventDefault(); run(async()=>{
  const password=$('password').value; $('password').value='';
  await api.call('/api/admin/live/reauth',{password,remember:$('remember').checked}); await poll();
});});
$('btnStartCam').addEventListener('click',()=>run(async()=>{
  message('Autorizează camera și microfonul. Încărcăm decuparea locală…');
  await media.startCamera({facingMode}); camera=true; $('preview-placeholder').hidden=true;
  message(media.isReady()?'Camera este pregătită. Verifică imaginea înainte de ON AIR.':'Camera funcționează. Se pregătește decuparea…');
}));
$('on-air').addEventListener('click',()=>run(async()=>{
  const previous=bootstrap?.sessionId && bootstrap.state!=='OFFLINE' ? bootstrap : null;
  await controller.start(previous);
  if(controller.mode==='PRIVATE_STANDBY') {
    privateCall.id=bootstrap.activePrivate?.id || bootstrap.resumePrivateId;
    $('recover').hidden=false;
  }
}));
$('off-air').addEventListener('click',()=>run(async()=>{try { await privateCall.end(false); } finally { await controller.offAir(); await poll(); }}));
$('stop-camera').addEventListener('click',()=>run(async()=>{await media.stop(); camera=false; $('preview-placeholder').hidden=false; message('Camera și microfonul sunt oprite.');}));
$('flip').addEventListener('click',()=>run(async()=>{facingMode=facingMode==='user'?'environment':'user'; await media.replaceCamera({facingMode});}));
$('retry-cut').addEventListener('click',()=>run(async()=>{await media.retrySegmentation();}));
$('logo').addEventListener('input',()=>media?.setLogo($('logo').value));
$('background').addEventListener('change',()=>media?.setBackground($('background').value));
const blobs=new Map();
async function loadVisual(file,key) {
  if(!file || file.size>50*1024*1024) throw new Error('FILE_SIZE');
  const url=URL.createObjectURL(file), video=file.type.startsWith('video/');
  const element=document.createElement(video?'video':'img');
  if(video) { element.muted=true; element.loop=true; element.playsInline=true; }
  try {
    await new Promise((resolve,reject)=>{element[video?'onloadeddata':'onload']=resolve; element.onerror=reject; element.src=url;});
    if(video) await element.play();
    const previous=blobs.get(key); previous?.element.pause?.(); if(previous) URL.revokeObjectURL(previous.url);
    blobs.set(key,{url,element}); return element;
  } catch(error) { URL.revokeObjectURL(url); throw error; }
}
$('background-file').addEventListener('change',()=>run(async()=>media.setBackground(await loadVisual($('background-file').files[0],'background'))));
$('mask-file').addEventListener('change',()=>run(async()=>media.setMask(await loadVisual($('mask-file').files[0],'mask'))));
async function endPrivate() { await privateCall.end(); $('private-call').hidden=true; $('recover').hidden=true; await poll(); }
$('end-private').addEventListener('click',()=>run(endPrivate));
$('recover').addEventListener('click',()=>run(async()=>{
  if(!controller.room) { message('Pornește camera, apoi apasă ON AIR pentru reconectare în pauză.'); return; }
  privateCall.id ||= bootstrap.activePrivate?.id || bootstrap.resumePrivateId;
  await endPrivate();
}));
$('party-open').addEventListener('click',()=>run(()=>partyHost?.open()));
$('party-close').addEventListener('click',()=>run(()=>partyHost?.close({confirmed:false})));
$('party-confirm-yes').addEventListener('click',()=>run(()=>partyHost?.close({confirmed:true})));
$('party-confirm-no').addEventListener('click',()=>{ $('party-confirm').hidden=true; });
$('party-microphone').addEventListener('click',()=>run(()=>partyHost?.setMicrophoneEnabled(!partyHost.state.microphoneEnabled)));
$('party-camera').addEventListener('click',()=>run(()=>partyHost?.setCameraEnabled(!partyHost.state.cameraEnabled)));
async function shutdown() {
  closing=true; clearTimeout(pollTimer);
  await partyHost?.destroy();
  await privateCall?.abort();
  try { await controller?.shutdown(); } catch { await media?.stop(); }
  wakeLock?.release().catch(()=>{}); wakeLock=null;
  for(const {url,element} of blobs.values()) { element.pause?.(); URL.revokeObjectURL(url); } blobs.clear();
}
$('logout').addEventListener('click',()=>run(async()=>{await shutdown(); await api.call('/api/admin/auth/logout',{}); location.assign('/admin/');}));
window.addEventListener('pagehide',()=>{shutdown();});
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible') { requestWakeLock(); if(!closing) poll(); }
  else if(controller?.room) message('Păstrează studioul în prim-plan. Android poate întrerupe camera în fundal.');
});
poll();
