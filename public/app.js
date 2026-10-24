'use strict';
const $ = id => document.getElementById(id);
const screens = { entry: $('entryScreen'), invite: $('inviteScreen'), chat: $('chatScreen') };
let ws = null, peer = null, channel = null, role = null, joined = false, ending = false;
let sessionCode = null, pendingIce = [], activeTransfers = new Map(), objectUrls = new Set();
let soundEnabled = false, audioContext = null;
let entryAnimationPromise = Promise.resolve();
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const CHUNK_BYTES = 8 * 1024;
const MAX_TEXT = 4000;
const MAX_TOTAL_INCOMING = 12 * 1024 * 1024;
const ALPHABET = /^[A-HJ-NP-Z2-9]{25}$/;
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]
}; // STUN helps discover network routes; TURN may still be needed on restrictive networks.

function runCodeAnimation() {
  const stage = $('codeStage');
  stage.classList.remove('animating','unlocked');
  void stage.offsetWidth;
  stage.classList.add('animating');
  return new Promise(resolve => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => {
      stage.classList.add('unlocked');
      stage.classList.remove('animating');
      $('stageCaption').textContent = 'Secure session handshake initiated.';
      beep(740,.06);
      setTimeout(() => {
        stage.classList.remove('unlocked');
        $('stageCaption').textContent = 'A new invitation. A new session.';
        resolve();
      }, reduced ? 30 : 420);
    }, reduced ? 30 : 1500);
  });
}

function setStatus(text, tone='neutral') {
  $('status').textContent = text.toUpperCase();
  $('statusDot').className = `status-dot${tone === 'good' ? ' good' : tone === 'bad' ? ' bad' : ''}`;
}
function showError(text) { $('entryError').textContent = text || ''; }
function showScreen(which) {
  Object.values(screens).forEach(el => el.classList.add('hidden'));
  screens[which].classList.remove('hidden');
}
function beep(freq=600, duration=.055) {
  if (!soundEnabled) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume();
    const osc = audioContext.createOscillator(), gain = audioContext.createGain();
    osc.type = 'sine'; osc.frequency.value = freq;
    gain.gain.setValueAtTime(.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(.025, audioContext.currentTime + .01);
    gain.gain.exponentialRampToValueAtTime(.0001, audioContext.currentTime + duration);
    osc.connect(gain); gain.connect(audioContext.destination);
    osc.start(); osc.stop(audioContext.currentTime + duration + .01);
  } catch {}
}
$('soundToggle').addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  $('soundToggle').textContent = soundEnabled ? '♫' : '♪';
  $('soundToggle').setAttribute('aria-label', soundEnabled ? 'Disable sound effects' : 'Enable sound effects');
  if (soundEnabled) beep(740);
});

$('createMode').addEventListener('click', () => setMode('create'));
$('joinMode').addEventListener('click', () => setMode('join'));
function setMode(mode) {
  const create = mode === 'create';
  $('createMode').classList.toggle('active', create);
  $('joinMode').classList.toggle('active', !create);
  $('createPane').classList.toggle('hidden', !create);
  $('joinPane').classList.toggle('hidden', create);
  $('entryMode').textContent = create ? 'CREATE A PRIVATE SESSION' : 'JOIN AN EXISTING SESSION';
  showError('');
}
$('createBtn').addEventListener('click', createSession);
$('joinBtn').addEventListener('click', joinSession);
$('codeInput').addEventListener('input', () => {
  $('codeInput').value = $('codeInput').value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0,25);
  showError('');
});
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinSession(); });

function openSocket() {
  return new Promise((resolve, reject) => {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${scheme}//${location.host}/signal`);
    ws = socket;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; socket.close(); reject(new Error('Connection timed out. Try again.')); }
    }, 9000);
    socket.addEventListener('open', () => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(); }
    }, { once:true });
    socket.addEventListener('error', () => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Could not connect to the session server.')); }
    }, { once:true });
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string' || event.data.length > 20_000) return;
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      handleSignal(msg).catch(() => endLocal('Connection error'));
    });
    socket.addEventListener('close', () => {
      if (joined && !ending) endLocal('Connection closed');
    });
  });
}
function sendSignal(msg) {
  if (ws?.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }
}
async function createSession() {
  showError('');
  $('createBtn').disabled = true;
  entryAnimationPromise = runCodeAnimation();
  try {
    await openSocket();
    role = 'creator';
    sendSignal({ type: 'create' });
    setStatus('Creating');
  } catch (err) {
    showError(err.message);
    $('createBtn').disabled = false;
    setStatus('Offline','bad');
  }
}
async function joinSession() {
  showError('');
  const code = $('codeInput').value.trim().toUpperCase();
  if (!ALPHABET.test(code)) { showError('Enter the complete 25-character invitation code.'); return; }
  $('joinBtn').disabled = true;
  setMode('create');
  entryAnimationPromise = runCodeAnimation();
  try {
    await openSocket();
    role = 'guest';
    sendSignal({ type:'join', code });
    setStatus('Checking invitation');
  } catch (err) {
    showError(err.message);
    $('joinBtn').disabled = false;
    setStatus('Offline','bad');
  }
}
function setupPeer() {
  if (peer) return peer;
  peer = new RTCPeerConnection(rtcConfig);
  peer.onicecandidate = e => { if (e.candidate) sendSignal({ type:'ice', candidate:e.candidate }); };
  peer.onconnectionstatechange = () => {
    if (!peer) return;
    $('peerState').textContent = ({
      connecting:'Negotiating encrypted connection…',
      connected:'Encrypted peer connection established',
      disconnected:'Peer connection interrupted',
      failed:'Connection failed. End this session and try a new invitation.',
      closed:'Connection closed'
    })[peer.connectionState] || 'Connecting…';
    if (peer.connectionState === 'connected') {
      setStatus('Connected','good');
      $('securityBanner').classList.add('connection-ready');
      $('messageInput').disabled = false;
      $('sendBtn').disabled = false;
      $('fileInput').disabled = false;
      $('messageInput').focus({ preventScroll:true });
      beep(880,.14);
      $('chatScreen').classList.remove('hidden');
    }
  };
  peer.ondatachannel = e => attachChannel(e.channel);
  return peer;
}
function attachChannel(ch) {
  channel = ch;
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = 64 * 1024;
  channel.onopen = () => {
    $('peerState').textContent = 'Encrypted peer connection established';
    $('messageInput').disabled = false;
    $('sendBtn').disabled = false;
    $('fileInput').disabled = false;
    setStatus('Connected','good');
    $('securityBanner').classList.add('connection-ready');
    $('messageInput').focus({preventScroll:true});
    beep(880,.14);
  };
  channel.onclose = () => { $('peerState').textContent = 'Encrypted channel closed'; };
  channel.onmessage = e => {
    if (typeof e.data !== 'string' || e.data.length > 16 * 1024) return;
    let packet; try { packet = JSON.parse(e.data); } catch { return; }
    if (!packet || typeof packet.kind !== 'string') return;
    if (packet.kind === 'text') {
      if (typeof packet.text === 'string' && packet.text.length <= MAX_TEXT) addTextMessage(packet.text,false);
    } else handleFilePacket(packet);
  };
}
function sendPacket(packet) {
  if (!channel || channel.readyState !== 'open') throw new Error('Secure connection is not ready.');
  const data = JSON.stringify(packet);
  if (data.length > 15 * 1024) throw new Error('Transfer chunk too large.');
  channel.send(data);
}
async function waitForBuffer() {
  if (!channel || channel.readyState !== 'open') throw new Error('Connection ended during transfer.');
  if (channel.bufferedAmount < 256 * 1024) return;
  await new Promise((resolve,reject) => {
    const timeout = setTimeout(() => reject(new Error('Transfer paused because the connection is slow.')), 15000);
    channel.addEventListener('bufferedamountlow', () => { clearTimeout(timeout); resolve(); }, { once:true });
  });
}
function addTextMessage(text, mine) {
  const el = document.createElement('article'); el.className = `message${mine ? ' mine' : ''}`;
  const who = document.createElement('small'); who.textContent = mine ? 'YOU' : 'PEER';
  const body = document.createElement('div'); body.textContent = text;
  el.append(who,body); $('messages').append(el); scrollToBottom(); beep(mine ? 520 : 700,.035);
}
function scrollToBottom() { $('messages').scrollTop = $('messages').scrollHeight; }
$('sendForm').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('messageInput').value;
  if (!text.trim() || text.length > MAX_TEXT || channel?.readyState !== 'open') return;
  try { sendPacket({kind:'text',text}); addTextMessage(text,true); $('messageInput').value=''; autoGrow(); }
  catch (err) { setTransferStatus(err.message); }
});
$('messageInput').addEventListener('input', autoGrow);
$('messageInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('sendForm').requestSubmit(); }
});
function autoGrow() {
  const el = $('messageInput'); el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight,130)}px`;
}

async function handleSignal(msg) {
  if (msg.type === 'created') {
    await entryAnimationPromise;
    sessionCode = msg.code; joined = true;
    $('inviteCode').textContent = msg.code;
    showScreen('invite'); setStatus('Waiting');
  } else if (msg.type === 'joined') {
    await entryAnimationPromise;
    joined = true; showScreen('chat'); setStatus('Connecting');
    setupPeer();
  } else if (msg.type === 'peer-joined') {
    showScreen('chat'); setStatus('Connecting');
    setupPeer();
    if (role === 'creator') {
      // The offerer must create the data channel before generating the offer.
      // The joining peer receives it through the ondatachannel handler.
      if (!channel) attachChannel(peer.createDataChannel('chat', { ordered: true }));
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      sendSignal({type:'offer',sdp:peer.localDescription.sdp});
    }
  } else if (msg.type === 'offer') {
    setupPeer();
    await peer.setRemoteDescription({type:'offer',sdp:msg.sdp});
    for (const c of pendingIce) { try { await peer.addIceCandidate(c); } catch {} }
    pendingIce=[];
    const answer=await peer.createAnswer(); await peer.setLocalDescription(answer);
    sendSignal({type:'answer',sdp:peer.localDescription.sdp});
    await updateVerificationCode();
  } else if (msg.type === 'answer') {
    if (!peer) return;
    await peer.setRemoteDescription({type:'answer',sdp:msg.sdp});
    for (const c of pendingIce) { try { await peer.addIceCandidate(c); } catch {} }
    pendingIce=[];
    await updateVerificationCode();
  } else if (msg.type === 'ice') {
    if (!msg.candidate || typeof msg.candidate.candidate !== 'string' || msg.candidate.candidate.length > 2000) return;
    if (peer?.remoteDescription) { try { await peer.addIceCandidate(msg.candidate); } catch {} }
    else pendingIce.push(msg.candidate);
  } else if (msg.type === 'error') {
    showError(msg.message || 'Could not join this session.');
    $('createBtn').disabled = false; $('joinBtn').disabled = false;
    setStatus('Rejected','bad');
  } else if (['session-ended','session-expired','peer-disconnected'].includes(msg.type)) {
    endLocal(msg.type === 'session-expired' ? 'Invitation/session expired' : 'Session ended');
  }
}
function fingerprint(sdp) {
  const m = sdp?.match(/a=fingerprint:sha-256\s+([^\r\n]+)/i);
  return m ? m[1].trim().toUpperCase() : null;
}
async function updateVerificationCode() {
  const a = fingerprint(peer?.localDescription?.sdp), b = fingerprint(peer?.remoteDescription?.sdp);
  if (!a || !b) return;
  const pair = [a,b].sort().join('|');
  const hash = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(pair));
  $('verificationCode').textContent = [...new Uint8Array(hash)].slice(0,8).map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase().match(/.{1,4}/g).join('-');
}

$('copyBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(sessionCode); $('copyBtn').textContent='Copied'; beep(780); }
  catch { $('copyBtn').textContent='Copy manually'; }
});
$('cancelInviteBtn').addEventListener('click', () => destroySession());
$('endBtn').addEventListener('click', () => {
  if (confirm('End the session for both people and clear this browser’s temporary chat data? Saved copies on either device cannot be erased.')) destroySession();
});

function setTransferStatus(text) { $('transferStatus').textContent = text || ''; }
const allowedExtensions = /\.(png|jpe?g|gif|webp|avif|bmp|pdf|txt|md|docx?|xlsx?|pptx?|odt|ods|rtf|csv)$/i;
function bytesToBase64(bytes) {
  let binary=''; for(let i=0;i<bytes.length;i+=0x8000) binary += String.fromCharCode(...bytes.subarray(i,i+0x8000));
  return btoa(binary);
}
function base64ToBytes(value) {
  const bin=atob(value), bytes=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
  return bytes;
}
async function sendFile(file) {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name}: maximum file size is 10 MB.`);
  if (!file.type.startsWith('image/') && !allowedExtensions.test(file.name)) throw new Error(`${file.name}: file type not supported.`);
  if (channel?.readyState !== 'open') throw new Error('Wait for the secure connection.');
  const id=crypto.randomUUID(), count=Math.ceil(file.size/CHUNK_BYTES);
  sendPacket({kind:'file-start',id,name:file.name.slice(0,160),mime:file.type.slice(0,100)||'application/octet-stream',size:file.size,count});
  const bytes=new Uint8Array(await file.arrayBuffer());
  for(let i=0;i<count;i++){
    await waitForBuffer();
    const part=bytes.subarray(i*CHUNK_BYTES,Math.min((i+1)*CHUNK_BYTES,bytes.length));
    sendPacket({kind:'file-chunk',id,index:i,data:bytesToBase64(part)});
    setTransferStatus(`Sending ${file.name} · ${Math.round((i+1)/Math.max(count,1)*100)}%`);
  }
  sendPacket({kind:'file-end',id}); setTransferStatus(`Sent ${file.name}`);
}
$('fileInput').addEventListener('change', async () => {
  const files=[...$('fileInput').files]; $('fileInput').value='';
  for(const file of files){ try { await sendFile(file); } catch(err){ setTransferStatus(err.message); } }
});
function handleFilePacket(p) {
  if (p.kind === 'file-start') {
    if(typeof p.id!=='string'||p.id.length>80||typeof p.name!=='string'||!Number.isInteger(p.size)||p.size<0||p.size>MAX_FILE_BYTES||!Number.isInteger(p.count)||p.count<0||p.count>Math.ceil(MAX_FILE_BYTES/CHUNK_BYTES)) return;
    if(activeTransfers.size>=2){setTransferStatus('Too many simultaneous transfers.');return;}
    activeTransfers.set(p.id,{name:p.name.slice(0,160),mime:typeof p.mime==='string'?p.mime.slice(0,100):'application/octet-stream',size:p.size,count:p.count,chunks:new Array(p.count),received:0});
    setTransferStatus(`Receiving ${p.name}…`); return;
  }
  if(p.kind==='file-chunk'){
    const t=activeTransfers.get(p.id);
    if(!t||!Number.isInteger(p.index)||p.index<0||p.index>=t.count||typeof p.data!=='string'||p.data.length>12*1024)return;
    if(!t.chunks[p.index]){
      try { const bytes=base64ToBytes(p.data); t.chunks[p.index]=bytes; t.received+=bytes.byteLength; }
      catch { activeTransfers.delete(p.id); setTransferStatus('Invalid file chunk; discarded.'); return; }
      const totalIncoming = [...activeTransfers.values()].reduce((sum, transfer) => sum + transfer.received, 0);
      if(t.received>t.size||totalIncoming>MAX_TOTAL_INCOMING){activeTransfers.delete(p.id);setTransferStatus('Combined incoming files exceed the transfer limit.');}
    } return;
  }
  if(p.kind==='file-end'){
    const t=activeTransfers.get(p.id); activeTransfers.delete(p.id);
    if(!t||t.chunks.some(c=>!c)||t.received!==t.size){setTransferStatus('Incomplete file discarded.');return;}
    renderFile(t); setTransferStatus(`Received ${t.name}`);
  }
}
function renderFile(t) {
  const wrap=document.createElement('article');wrap.className='message file-message';
  const who=document.createElement('small');who.textContent='PEER SHARED';
  const name=document.createElement('div');name.textContent=t.name;
  const meta=document.createElement('div');meta.className='file-meta';meta.textContent=`${(t.size/1024).toFixed(1)} KB · ${t.mime}`;
  const blob=new Blob(t.chunks,{type:t.mime||'application/octet-stream'}), url=URL.createObjectURL(blob);objectUrls.add(url);
  wrap.append(who,name,meta);
  if(t.mime.startsWith('image/')){
    const img=document.createElement('img');img.className='shared-image';img.alt=t.name;img.loading='lazy';img.src=url;wrap.append(img);
  }
  const link=document.createElement('a');link.className='file-download';link.href=url;link.download=t.name;link.rel='noopener';link.textContent='Download file';wrap.append(link);
  $('messages').append(wrap);scrollToBottom();
}
function clearLocalData() {
  $('messages').replaceChildren();
  $('messageInput').value=''; $('codeInput').value=''; $('inviteCode').textContent='';
  $('verificationCode').textContent='Session destroyed';
  activeTransfers.clear(); pendingIce=[];
  for(const url of objectUrls){try{URL.revokeObjectURL(url);}catch{}}
  objectUrls.clear();
  $('messageInput').disabled=true;$('sendBtn').disabled=true;$('fileInput').disabled=true;
  $('transferStatus').textContent=''; $('peerState').textContent='Session destroyed';
  sessionCode=null;
}
function destroySession() {
  if (ending) return; ending=true;
  sendSignal({type:'end'});
  endLocal('Session destroyed',true);
  $('destroyOverlay').classList.remove('hidden');
  setStatus('Destroyed','good');
  setTimeout(() => {
    $('destroyOverlay').classList.add('hidden');
    ending=false; showScreen('entry');
    $('createBtn').disabled=false;$('joinBtn').disabled=false;
    setMode('create');setStatus('Ready');
  }, 1900);
}
function endLocal(reason, initiated=false) {
  joined=false;
  try { if(channel && channel.readyState==='open') channel.close(); } catch {}
  try { peer?.close(); } catch {}
  peer=null;channel=null;
  if(ws && ws.readyState===WebSocket.OPEN && !initiated) { /* server has already ended the room or connection */ }
  try { ws?.close(); } catch {}
  ws=null; role=null;
  clearLocalData();
  if(!ending) {
    setStatus(reason || 'Disconnected', 'bad');
    showScreen('entry');
    showError(reason || '');
    $('createBtn').disabled=false;$('joinBtn').disabled=false;
  }
}
$('securityInfoBtn').addEventListener('click', () => $('securityDialog').showModal());
$('closeSecurityDialog').addEventListener('click', () => $('securityDialog').close());

document.addEventListener('visibilitychange', () => {
  if (!screens.chat.classList.contains('hidden') && document.visibilityState === 'hidden') $('privacyVeil').classList.remove('hidden');
  else $('privacyVeil').classList.add('hidden');
});
// Do not destroy sessions on pagehide: mobile browsers may fire lifecycle events
// while opening the system file picker. The server will clean up when sockets truly close.
window.addEventListener('pagehide', () => {});
$('fileInput').disabled=true;
setStatus('Ready');
