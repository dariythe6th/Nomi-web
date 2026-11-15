import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { T, encode, decode, json, unjson, encPos, decPos, u16 } from '../shared/protocol.mjs';
import { genKeys, derive, seal, open } from '../shared/crypto.mjs';
import { dist, validateMove } from '../shared/geo.mjs';

const OPT = process.env.NOMI_OPT !== '0';          // 0 = baseline (no optimisations), for PR5
const BOTS = +process.env.NOMI_BOTS || 3;           // demo friends
const RADIUS = 5000, MIN_MOVE = 3;                  // relevance radius (m), dormancy threshold (m)
const root = path.resolve(import.meta.dirname, '..');
const allowed = [path.join(root, 'public'), path.join(root, 'shared')];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const stats = { bytesOut: 0, pktOut: 0, skipped: 0, rejected: 0, authFail: 0, dupes: 0, bad: 0 };
const media = new Map(); let mediaId = 0;

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/upload') {
    const ch = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 8e6) req.destroy(); else ch.push(c); });
    req.on('end', () => {
      const id = ++mediaId;
      media.set(id, { buf: Buffer.concat(ch), type: req.headers['content-type'] || 'video/webm' });
      res.end(JSON.stringify({ url: '/media/' + id }));
    });
    return;
  }
  if (req.url.startsWith('/media/')) {
    const m = media.get(+req.url.slice(7));
    if (!m) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': m.type }); return void res.end(m.buf);
  }
  if (req.url === '/stats') { res.setHeader('content-type', 'application/json'); return void res.end(JSON.stringify({ opt: OPT, ...stats })); }
  let f = req.url.split('?')[0];
  f = f === '/' ? '/public/index.html' : f.startsWith('/shared/') ? f : '/public' + f;
  const fp = path.join(root, f);
  if (!allowed.some((a) => fp.startsWith(a + path.sep)) || !fs.existsSync(fp)) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

// ---- world state: id -> {id,name,lat,lon}; 1..99 users, 101+ bots
const ents = new Map(); const sessions = new Set(); let nextId = 1;
const COLORS = ['#e6397a', '#12a594', '#5b5bd6', '#f08c00', '#2f80ed', '#8e44ad'];
const BIOS = ['Гуляю по центру', 'На связи после 18:00', 'Ищу кофе рядом'];
const REPLIES = ['Привет! Давай встретимся?', 'Я рядом, посмотри на карте', 'Окей, выхожу', 'Через 10 минут буду'];
let botSeq = 0;
const names = ['Аня', 'Ден', 'Маша', 'Илья', 'Катя'];
for (let i = 0; i < BOTS; i++) {
  const id = 101 + i;
  ents.set(id, { id, name: names[i % 5] + (i >= 5 ? i : ''), bot: true, still: i % 3 === 2, color: COLORS[i % 6], bio: BIOS[i % 3],
    lat: 55.7558 + (Math.random() - 0.5) * 0.05, lon: 37.6173 + (Math.random() - 0.5) * 0.08 });
}
const roster = () => Object.fromEntries([...ents].map(([id, e]) => [id, { name: e.name, color: e.color, bio: e.bio }]));

async function send(s, type, payload = new Uint8Array(0), ack = 0, seqOverride) {
  const seq = seqOverride ?? (s.seq = (s.seq + 1) & 0xffff);
  const out = await seal(s.key, 2, s.ctr++, encode(type, seq, payload, ack));
  stats.bytesOut += out.length; stats.pktOut++;
  if (s.ws.readyState === 1) s.ws.send(out);
}
const announce = () => sessions.forEach((s) => send(s, T.WELCOME, json({ you: s.id, roster: roster() })));

// Replication: relevance radius + dormancy (delta threshold). OPT=0 sends everything to everyone.
function relay(e) {
  if (e.lat === null) return;
  for (const s of sessions) {
    if (s.id === e.id) continue;
    if (OPT) {
      if (s.ent.lat !== null && dist(s.ent, e) > RADIUS) { stats.skipped++; continue; }
      const last = s.sent.get(e.id);
      if (last && dist(last, e) < MIN_MOVE) { stats.skipped++; continue; }
    }
    s.sent.set(e.id, { lat: e.lat, lon: e.lon });
    send(s, T.POSITION, encPos(e.id, e.lat, e.lon));
  }
}
setInterval(() => {
  for (const e of ents.values()) {
    if (!e.bot) continue;
    if (!e.still) { e.lat += (Math.random() - 0.5) * 1 / 111320; e.lon += (Math.random() - 0.5) * 1 / 63000; }
    relay(e);
  }
}, 200);

function handle(s, m, ip) {
  if (m.requiresAck) {
    send(s, T.ACK, u16(m.seq));
    if (s.seen.has(m.seq)) { stats.dupes++; return; }          // dedup window: no repeated effect
    s.seen.add(m.seq); if (s.seen.size > 256) s.seen.delete(s.seen.values().next().value);
  }
  switch (m.type) {
    case T.PING: {
      if (m.payload.length !== 8) return;
      const t = BigInt(Date.now()) * 1000n, out = new Uint8Array(24), o = new DataView(out.buffer);
      out.set(m.payload); o.setBigUint64(8, t); o.setBigUint64(16, t);
      send(s, T.PONG, out, 0, m.seq); break;
    }
    case T.POSITION: {
      const p = decPos(m.payload); if (!p) return;
      const now = Date.now(), e = s.ent;
      if (e.lat !== null && !validateMove(e, p, now - s.posT)) {  // server authority
        stats.rejected++; console.log('REJECT_MOVE', ip, s.id);
        const c = new Uint8Array(11); c.set(u16(m.seq)); c.set(encPos(s.id, e.lat, e.lon), 2);
        send(s, T.CORRECTION, c); return;
      }
      e.lat = p.lat; e.lon = p.lon; s.posT = now; relay(e); break;
    }
    case T.PROFILE: {
      const o = unjson(m.payload); if (!o || typeof o !== 'object') return;
      const name = String(o.name ?? '').trim().slice(0, 20);
      if (name) s.ent.name = name;
      s.ent.bio = String(o.bio ?? '').slice(0, 60);
      if (/^#[0-9a-f]{6}$/i.test(o.color)) s.ent.color = o.color;
      announce(); break;
    }
    case T.CHAT: case T.REACTION: {              // private 1:1 routing
      const o = unjson(m.payload); if (!o || typeof o !== 'object') return;
      const to = +o.to, peer = ents.get(to);
      if (!peer || to === s.id) return;
      if (peer.bot) {
        if (m.type === T.CHAT) setTimeout(() => send(s, T.CHAT, json({ mid: `${to}:${++botSeq}`, from: to, to: s.id, text: REPLIES[botSeq % REPLIES.length] })), 1200);
        return;
      }
      const out = m.type === T.CHAT
        ? { mid: `${s.id}:${m.seq}`, from: s.id, to, text: String(o.text ?? '').slice(0, 500), video: String(o.video ?? '').startsWith('/media/') ? o.video : undefined }
        : { mid: String(o.mid).slice(0, 12), e: String(o.e).slice(0, 8), from: s.id, to };
      sessions.forEach((x) => x.id === to && send(x, m.type, json(out)));
    }
  }
}

const wss = new WebSocketServer({ server, maxPayload: 16384 });
wss.on('connection', (ws, req) => {
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
  const s = { ws, key: null, seq: 0, ctr: 0, id: 0, posT: 0, sent: new Map(), seen: new Set(), ent: null };
  ws.on('message', async (raw) => {
    const buf = new Uint8Array(raw), d = decode(buf);
    if (!d) { stats.bad++; return; }
    if (d.type === T.KEY_EXCHANGE) {
      if (s.key) return;
      const kp = await genKeys();
      s.key = await derive(kp.k.privateKey, d.payload).catch(() => null);
      if (!s.key || nextId > 99) return ws.close();
      ws.send(encode(T.KEY_EXCHANGE, 0, kp.pub));
      s.id = nextId++; s.ent = { id: s.id, name: 'Друг' + s.id, color: '#5b5bd6', bio: '', lat: null, lon: null };
      ents.set(s.id, s.ent); sessions.add(s); announce();
      for (const e of ents.values()) if (e.lat !== null && e.id !== s.id) { s.sent.set(e.id, { lat: e.lat, lon: e.lon }); send(s, T.POSITION, encPos(e.id, e.lat, e.lon)); }
      return;
    }
    if (d.type !== T.ENCRYPTED || !s.key) return;
    const inner = await open(s.key, buf);
    if (!inner) { stats.authFail++; console.log('AUTH_FAIL', ip); return; }
    handle(s, inner, ip);
  });
  ws.on('close', () => { if (s.id) { sessions.delete(s); ents.delete(s.id); announce(); } });
});
const PORT = +process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Nomi on http://localhost:${PORT} (opt=${OPT}, bots=${BOTS})`));
