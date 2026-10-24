import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`;
const publicUrl = new URL(PUBLIC_ORIGIN);
const websocketOrigin = `${publicUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${publicUrl.host}`;

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${websocketOrigin}; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { etag:false, maxAge:0, index:'index.html' }));

const wss = new WebSocketServer({ noServer:true, perMessageDeflate:false, maxPayload:16*1024 });
const rooms = new Map(); // Volatile RAM only. No database, messages, or file storage.
const sockets = new Map();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // exactly 32 symbols
const inviteTtl = 10 * 60 * 1000;
const activeTtl = 60 * 60 * 1000;
const maxConnectionsPerIp = 8;
const ipConnections = new Map();

function makeCode() {
  // Rejection sampling avoids modulo bias; 25 chars from 32 symbols = 125 bits.
  let out = '';
  while (out.length < 25) {
    for (const b of crypto.randomBytes(64)) {
      if (b < 224) out += alphabet[b & 31];
      if (out.length === 25) break;
    }
  }
  return out;
}
function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    const payload = JSON.stringify(data);
    if (payload.length <= 15_000) ws.send(payload);
  }
}
function destroyRoom(id, reason='session-ended') {
  const room = rooms.get(id);
  if (!room) return;
  rooms.delete(id);
  for (const peer of room.peers.values()) {
    sockets.delete(peer.ws);
    if (peer.ws.readyState === WebSocket.OPEN) {
      send(peer.ws, {type:reason});
      peer.ws.close(1000, 'Session ended');
    }
  }
  room.peers.clear();
}
function metadata(ws) { const m=sockets.get(ws); return m ? {m,room:rooms.get(m.roomId)} : {}; }
function leave(ws) {
  const meta=sockets.get(ws);
  if (!meta) return;
  sockets.delete(ws);
  const room=rooms.get(meta.roomId);
  if (room) destroyRoom(meta.roomId,'peer-disconnected');
}
function originOK(req) { return typeof req.headers.origin === 'string' && req.headers.origin === PUBLIC_ORIGIN; }

server.on('upgrade',(req,socket,head)=>{
  if(req.url!=='/signal'||!originOK(req)){
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;
  }
  const ip=req.socket.remoteAddress||'unknown';
  const count=ipConnections.get(ip)||0;
  if(count>=maxConnectionsPerIp){
    socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');socket.destroy();return;
  }
  ipConnections.set(ip,count+1);
  wss.handleUpgrade(req,socket,head,ws=>{ws._ipKey=ip;wss.emit('connection',ws,req);});
});

wss.on('connection',ws=>{
  let authenticated=false;
  let messageWindowStart=Date.now(), messageCount=0, invalidJoinAttempts=0;
  const authTimer=setTimeout(()=>{if(!authenticated)ws.close(1008,'Join/create timeout');},10_000);
  ws.on('message',raw=>{
    const now=Date.now();
    if(now-messageWindowStart>10_000){messageWindowStart=now;messageCount=0;}
    messageCount++;
    if(messageCount>80){ws.close(1008,'Rate limit exceeded');return;}
    let msg;
    try { msg=JSON.parse(raw.toString()); } catch { ws.close(1007,'Invalid JSON');return; }
    if(!msg||typeof msg.type!=='string'){ws.close(1008,'Invalid message');return;}
    if(!authenticated){
      if(msg.type==='create'){
        let code;
        do { code=makeCode(); } while(rooms.has(code));
        const room={createdAt:Date.now(),expiresAt:Date.now()+inviteTtl,peers:new Map(),active:false};
        rooms.set(code,room);
        const peerId=crypto.randomUUID();
        room.peers.set(peerId,{ws,role:'creator'});
        sockets.set(ws,{roomId:code,peerId});
        authenticated=true;clearTimeout(authTimer);
        send(ws,{type:'created',code,expiresAt:room.expiresAt});return;
      }
      if(msg.type==='join'&&typeof msg.code==='string'&&/^[A-HJ-NP-Z2-9]{25}$/.test(msg.code)){
        const room=rooms.get(msg.code);
        if(!room||room.active||room.expiresAt<Date.now()||room.peers.size!==1){
          invalidJoinAttempts++;
          send(ws,{type:'error',message:'Invitation invalid, expired, or already used.'});
          if(invalidJoinAttempts>=5)ws.close(1008,'Too many invalid invitations');
          return;
        }
        room.active=true;room.expiresAt=Date.now()+activeTtl;
        const peerId=crypto.randomUUID();
        room.peers.set(peerId,{ws,role:'guest'});sockets.set(ws,{roomId:msg.code,peerId});
        authenticated=true;clearTimeout(authTimer);
        send(ws,{type:'joined'});
        for(const p of room.peers.values())if(p.ws!==ws)send(p.ws,{type:'peer-joined'});
        return;
      }
      send(ws,{type:'error',message:'Create a session or join with an invitation code.'});return;
    }
    const {m,room}=metadata(ws);
    if(!m||!room||room.expiresAt<Date.now()){ws.close(1008,'Session expired');return;}
    if(msg.type==='end'){destroyRoom(m.roomId,'session-ended');return;}
    if(['offer','answer','ice'].includes(msg.type)){
      if(msg.type==='ice'){
        if(!msg.candidate||typeof msg.candidate.candidate!=='string'||msg.candidate.candidate.length>2000)return;
      }else if(typeof msg.sdp!=='string'||msg.sdp.length>12_000)return;
      for(const p of room.peers.values())if(p.ws!==ws)send(p.ws,msg);
    }else send(ws,{type:'error',message:'Unsupported signaling message.'});
  });
  ws.on('close',()=>{
    clearTimeout(authTimer);
    const ip=ws._ipKey;
    if(ip){const n=Math.max(0,(ipConnections.get(ip)||1)-1);if(n===0)ipConnections.delete(ip);else ipConnections.set(ip,n);}
    leave(ws);
  });
  ws.on('error',()=>{});
});

const expirySweep=setInterval(()=>{
  const now=Date.now();
  for(const [id,room] of rooms)if(room.expiresAt<=now)destroyRoom(id,'session-expired');
},30_000);
expirySweep.unref();

app.get('/healthz',(_req,res)=>res.status(200).json({ok:true}));
server.listen(PORT,()=>console.log(`VeilChat listening on port ${PORT}`));
