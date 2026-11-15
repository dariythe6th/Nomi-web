import { T, encode, decode, json, unjson, encPos, decPos } from '/shared/protocol.mjs';
import { genKeys, derive, seal, open } from '/shared/crypto.mjs';
import { ReliableChannel, AdaptiveTimeout } from '/shared/reliability.mjs';
import { validateMove, meetingPoint, dist } from '/shared/geo.mjs';

// ?loss=0.1 drops 10% of outgoing packets, ?lag=100 adds 100 ms, ?csp=0 disables prediction
const q = new URLSearchParams(location.search);
const LOSS = +q.get('loss') || 0, LAG = +q.get('lag') || 0, CSP = q.get('csp') !== '0';
const $ = (s) => document.querySelector(s), now = () => Math.round(performance.now() * 1000);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const toast = (t) => { const e = $('#toast'); e.textContent = t; e.className = 'on'; clearTimeout(toast.h); toast.h = setTimeout(() => (e.className = ''), 2600); };
const COLORS = ['#e6397a', '#12a594', '#5b5bd6', '#f08c00', '#2f80ed', '#8e44ad'];
const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#888888');
const store = { get() { try { return JSON.parse(localStorage.getItem('nomi.profile')); } catch { return null; } }, set(v) { try { localStorage.setItem('nomi.profile', JSON.stringify(v)); } catch {} } };
const mine = Object.assign({ name: '', bio: '', color: COLORS[0] }, store.get());

// ---------- state
const me = { id: 0, lat: null, lon: null, marker: null }, friends = new Map(), dialogs = new Map();
let roster = {}, openPeer = null;
const prof = (id) => roster[id] || { name: 'Друг', color: '#888888', bio: '' };
const dlg = (id) => { if (!dialogs.has(id)) dialogs.set(id, { msgs: [], unread: 0 }); return dialogs.get(id); };
const fmtDist = (m) => (m < 1000 ? Math.round(m) + ' м' : (m / 1000).toFixed(1) + ' км');
const eta = (m) => Math.max(1, Math.round(m / 83)) + ' мин пешком';
function avatar(p, cls = '') { const a = el('div', 'av ' + cls, ((p.name || '?')[0] || '?').toUpperCase()); a.style.background = safeColor(p.color); return a; }
const icon = (p) => L.divIcon({ className: '', iconSize: [44, 44], html: avatar(p).outerHTML });

// ---------- map
const map = L.map('map', { zoomControl: false }).setView([55.7558, 37.6173], 14);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
function setMe(lat, lon) {
  const first = !me.marker; me.lat = lat; me.lon = lon;
  if (first) { me.marker = L.marker([lat, lon], { icon: icon({ ...mine, name: 'Я' }), zIndexOffset: 999 }).addTo(map); map.setView([lat, lon], 15); }
  else me.marker.setLatLng([lat, lon]);
}
(function smooth() { // network smoothing for remote friends
  for (const f of friends.values()) { f.cur.lat += (f.lat - f.cur.lat) * 0.15; f.cur.lon += (f.lon - f.cur.lon) * 0.15; f.marker.setLatLng([f.cur.lat, f.cur.lon]); }
  requestAnimationFrame(smooth);
})();

// ---------- secure transport (ПР6), reliability (ПР3), telemetry (ПР2)
const kp = await genKeys();
let key = null, ctr = 0, seq = 0, ready; const gate = new Promise((r) => (ready = r));
const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
ws.binaryType = 'arraybuffer';
ws.onopen = () => ws.send(encode(T.KEY_EXCHANGE, 0, kp.pub));
ws.onmessage = async (e) => {
  const buf = new Uint8Array(e.data), d = decode(buf); if (!d) return;
  if (d.type === T.KEY_EXCHANGE) { key = await derive(kp.k.privateKey, d.payload); ready(); return; }
  await gate; const m = await open(key, buf); if (m) onPacket(m);
};
async function tx(inner) {
  if (!key || Math.random() < LOSS) return;
  const out = await seal(key, 1, ctr++, inner);
  LAG ? setTimeout(() => ws.send(out), LAG) : ws.send(out);
}
const chan = new ReliableChannel(5), to = new AdaptiveTimeout(), pings = new Map(), ticks = new Map(), stat = { ping: 0, pong: 0 };
function send(type, payload = new Uint8Array(0), ack = 0) {
  seq = (seq + 1) & 0xffff; const inner = encode(type, seq, payload, ack);
  if (ack) chan.onSent(seq, inner, now());
  tx(inner); return seq;
}
setInterval(() => { if (!key) return; const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(now())); pings.set(send(T.PING, b), now()); stat.ping++; }, 2000);
setInterval(() => {
  for (const p of chan.collect(now(), to.rtoMs() * 1000)) tx(p.raw);
  for (const s of chan.drainFailed()) { const m = ticks.get(s); if (m) { m.status = '✗'; renderDialog(); } toast('Сообщение не доставлено'); }
}, 100);

// ---------- movement: prediction + reconciliation (ПР4)
const pend = [], wait = new Map();
function moveTo(lat, lon) {
  if (!key) return; const t = performance.now(), p = encPos(me.id, lat, lon);
  if (CSP) { pend.push({ seq: send(T.POSITION, p), lat, lon, t }); setMe(lat, lon); }
  else wait.set(send(T.POSITION, p, 1), { lat, lon, t });
}
setInterval(() => { const t = performance.now() - 3000; while (pend.length && pend[0].t < t) pend.shift(); }, 1000);
function reconcile(c) {
  const i = pend.findIndex((x) => x.seq === c.seq);
  let base = { lat: c.lat, lon: c.lon }, pt = i >= 0 ? pend[i].t : performance.now();
  const rest = pend.splice(0).slice(i + 1);
  for (const x of rest) { if (validateMove(base, x, x.t - pt)) { base = x; pt = x.t; pend.push(x); } else break; }
  setMe(base.lat, base.lon); toast('Сервер исправил позицию');
}

// ---------- incoming packets
function onPacket(m) {
  switch (m.type) {
    case T.WELCOME: {
      const o = unjson(m.payload); if (!o) return;
      const first = !me.id; me.id = o.you; roster = o.roster;
      for (const [id, f] of friends) { if (!(id in roster)) { f.marker.remove(); friends.delete(id); } else f.marker.setIcon(icon(prof(id))); }
      if (first && (mine.name || mine.bio || mine.color !== COLORS[0])) send(T.PROFILE, json(mine), 1);
      renderAll(); break;
    }
    case T.POSITION: {
      const p = decPos(m.payload); if (!p || p.id === me.id) return;
      const f = friends.get(p.id);
      if (f) { f.lat = p.lat; f.lon = p.lon; }
      else {
        const marker = L.marker([p.lat, p.lon], { icon: icon(prof(p.id)) }).addTo(map); marker.on('click', () => openProfile(p.id));
        friends.set(p.id, { lat: p.lat, lon: p.lon, cur: { lat: p.lat, lon: p.lon }, marker }); renderFriends();
      }
      break;
    }
    case T.CORRECTION: {
      const v = new DataView(m.payload.buffer, m.payload.byteOffset, m.payload.length), pos = decPos(m.payload.subarray(2));
      if (pos) reconcile({ seq: v.getUint16(0), lat: pos.lat, lon: pos.lon }); break;
    }
    case T.PONG: {
      const t0 = pings.get(m.seq); if (t0 === undefined) return;
      pings.delete(m.seq); stat.pong++; to.onSample((now() - t0) / 1000); break;
    }
    case T.ACK: {
      const a = (m.payload[0] << 8) | m.payload[1], p = chan.onAck(a);
      if (p && p.attempts === 1) to.onSample((now() - p.firstSentUs) / 1000);   // Karn
      const msg = ticks.get(a); if (msg) { msg.status = '✓'; renderDialog(); }
      const w = wait.get(a); if (w) { wait.delete(a); setMe(w.lat, w.lon); toast(`ввод → реакция: ${Math.round(performance.now() - w.t)} мс`); }
      break;
    }
    case T.CHAT: {
      const o = unjson(m.payload); if (!o || typeof o.text !== 'string' && typeof o.video !== 'string') return;
      const d = dlg(o.from); d.msgs.push({ mid: o.mid, from: o.from, text: o.text, video: o.video, t: Date.now(), rx: {} });
      if (openPeer !== o.from) { d.unread++; toast(`${prof(o.from).name}: ${o.text || 'кружок'}`); }
      renderAll(); break;
    }
    case T.REACTION: {
      const o = unjson(m.payload); if (!o || !EMOJI.includes(o.e)) return;
      const msg = dlg(o.from).msgs.find((x) => x.mid === o.mid); if (msg) { msg.rx[o.e] = (msg.rx[o.e] || 0) + 1; renderDialog(); }
      break;
    }
  }
}

// ---------- navigation
function go(v) {
  document.querySelectorAll('.view,#tabs button').forEach((x) => x.classList.remove('on'));
  $('#v-' + v).classList.add('on'); document.querySelector(`#tabs [data-v=${v}]`).classList.add('on');
  if (v === 'map') { map.invalidateSize(); setTimeout(() => map.invalidateSize(), 50); }
  renderAll();
}
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => { closeOv(); go(b.dataset.v); }));
const ov = (id, on) => { const e = $(id); e.classList.toggle('open', on); e.setAttribute('aria-hidden', String(!on)); };
function closeOv() { openPeer = null; ov('#profile', false); ov('#dialog', false); }
document.querySelectorAll('.back').forEach((b) => (b.onclick = closeOv));

// ---------- friends list and friend profile page
function friendRow(id, onclick, sub, right) {
  const p = prof(id), b = el('button', 'row'), t = el('div', 't');
  t.append(el('b', '', p.name), el('small', '', sub)); b.append(avatar(p), t);
  if (right) b.append(right); b.onclick = onclick; return b;
}
function renderFriends() {
  const box = $('#flist'), s = $('#fsearch').value.trim().toLowerCase();
  const ids = Object.keys(roster).map(Number).filter((id) => id !== me.id && prof(id).name.toLowerCase().includes(s));
  if (!ids.length) return box.replaceChildren(el('div', 'empty', s ? 'Никого не найдено' : 'Пока никого нет онлайн'));
  box.replaceChildren(...ids.map((id) => {
    const f = friends.get(id), d = f && me.lat !== null ? fmtDist(dist(me, f)) : f ? 'на карте' : 'нет геопозиции';
    return friendRow(id, () => openProfile(id), prof(id).bio || 'Без статуса', el('span', 'r', d));
  }));
}
$('#fsearch').oninput = renderFriends;
function openProfile(id) {
  const p = prof(id), f = friends.get(id), body = $('#pbody'); body.className = 'body center';
  const d = f && me.lat !== null ? dist(me, f) : null;
  const actions = el('div', 'actions'), w = el('button', '', 'Написать'), r = el('button', 'alt', 'Маршрут'), mt = el('button', 'alt', 'Встреча');
  w.onclick = () => openDialog(id);
  r.onclick = () => (f && me.lat !== null ? (closeOv(), go('map'), route(me, f)) : toast('Нужны геопозиции обоих'));
  mt.onclick = () => (closeOv(), go('map'), meet([id]));
  actions.append(w, r, mt);
  body.replaceChildren(avatar(p, 'lg'), el('h2', '', p.name), el('p', '', p.bio || 'Без статуса'),
    el('p', '', d === null ? (f ? 'Ваша геопозиция неизвестна' : 'Геопозиция скрыта') : `${fmtDist(d)} · ${eta(d)}`), actions);
  ov('#profile', true);
}

// ---------- private dialogs (1:1)
const EMOJI = ['❤️', '👍', '😂'];
function renderChats() {
  const box = $('#clist'), list = [...dialogs].filter(([, d]) => d.msgs.length).sort((a, b) => b[1].msgs.at(-1).t - a[1].msgs.at(-1).t);
  let total = 0; list.forEach(([, d]) => (total += d.unread));
  $('#badge').hidden = !total; $('#badge').textContent = total;
  if (!list.length) return box.replaceChildren(el('div', 'empty', 'Диалогов пока нет. Откройте профиль друга и нажмите «Написать».'));
  box.replaceChildren(...list.map(([id, d]) => {
    const last = d.msgs.at(-1), right = el('div', 'r', new Date(last.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    if (d.unread) right.append(el('br'), el('span', 'badge', String(d.unread)));
    return friendRow(id, () => openDialog(id), (last.from === me.id ? 'Вы: ' : '') + (last.text || '🎥 Кружок'), right);
  }));
}
function openDialog(id) {
  openPeer = id; dlg(id).unread = 0; ov('#profile', false);
  const h = $('#dhead'), p = prof(id), f = friends.get(id); h.replaceChildren(avatar(p, 'sm'));
  const t = el('div'); t.append(el('b', '', p.name), el('small', '', f && me.lat !== null ? fmtDist(dist(me, f)) + ' от вас' : p.bio || ''));
  h.append(t); h.onclick = () => openProfile(id);
  ov('#dialog', true); renderDialog(); renderChats();
}
function renderDialog() {
  if (openPeer === null) return; const box = $('#dmsgs'), d = dlg(openPeer);
  if (!d.msgs.length) return box.replaceChildren(el('div', 'empty', 'Напишите первым'));
  box.replaceChildren(...d.msgs.map((m) => {
    const b = el('div', 'm' + (m.from === me.id ? ' me' : ''));
    if (typeof m.video === 'string' && m.video.startsWith('/media/')) {
      const v = el('video', 'circle'); v.src = m.video; v.loop = v.muted = v.playsInline = v.autoplay = true; v.onclick = (e) => { e.stopPropagation(); v.muted = !v.muted; }; b.append(v);
    }
    if (m.text) b.append(el('span', '', m.text));
    b.append(el('div', 'meta', new Date(m.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + (m.from === me.id ? ' ' + (m.status || '') : '')));
    const rx = el('div', 'rxs');
    for (const e of EMOJI) {
      if (m.open) { const bt = el('button', '', e + (m.rx[e] || '')); bt.onclick = (ev) => { ev.stopPropagation(); react(m, e); }; rx.append(bt); }
      else if (m.rx[e]) rx.append(el('span', '', e + m.rx[e]));
    }
    if (rx.childNodes.length) b.append(rx);
    b.onclick = () => { m.open = !m.open; renderDialog(); }; return b;
  }));
  box.scrollTop = box.scrollHeight;
}
function react(m, e) { m.rx[e] = (m.rx[e] || 0) + 1; m.open = false; send(T.REACTION, json({ to: openPeer, mid: m.mid, e })); renderDialog(); }
function sendChat(peer, o) {
  const s = send(T.CHAT, json({ to: peer, ...o }), 1), m = { mid: `${me.id}:${s}`, from: me.id, t: Date.now(), status: '…', rx: {}, ...o };
  dlg(peer).msgs.push(m); ticks.set(s, m); renderAll();
}
$('#f').onsubmit = (e) => { e.preventDefault(); const t = $('#txt').value.trim(); if (t && key && openPeer !== null) { sendChat(openPeer, { text: t }); $('#txt').value = ''; } };
$('#cam').onclick = async () => {
  const peer = openPeer;
  try {
    const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 360, height: 360 }, audio: true });
    const pv = $('#prev'); pv.srcObject = st; pv.hidden = false; await pv.play();
    const rec = new MediaRecorder(st), ch = []; rec.ondataavailable = (e) => ch.push(e.data);
    rec.onstop = async () => {
      st.getTracks().forEach((t) => t.stop()); pv.hidden = true;
      const r = await fetch('/upload', { method: 'POST', body: new Blob(ch, { type: rec.mimeType }), headers: { 'content-type': rec.mimeType } });
      sendChat(peer, { video: (await r.json()).url });
    };
    rec.start(); toast('Запись 10 с, тап по кругу — стоп');
    pv.onclick = () => rec.state === 'recording' && rec.stop();
    setTimeout(() => rec.state === 'recording' && rec.stop(), 10000);
  } catch { toast('Нет доступа к камере (нужен HTTPS или localhost)'); }
};

// ---------- meeting spot and routes
let spotMarker, routeLine, routeToken = 0;
const FOOT = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/'; // real pedestrian profile
const spotIcon = L.divIcon({ className: '', iconSize: [44, 56], iconAnchor: [22, 46], html: '<div class="spot"><i></i></div><div class="spot-l">Встреча</div>' });
const clearRoute = () => { routeToken++; routeLine?.remove(); routeLine = null; };
const fit = (ll, card) => { map.invalidateSize(); map.fitBounds(L.latLngBounds(ll), { paddingTopLeft: [30, 60], paddingBottomRight: [70, card ? 190 : 90], maxZoom: 17 }); };
async function route(a, b, fitView = true) {          // a -> b, each {lat, lon}
  clearRoute(); const tok = routeToken; let line, note, bounds;
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 7000);
  try {
    const response = await fetch(`${FOOT}${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`, { signal: ctl.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rr = await response.json();
    if (rr.code !== 'Ok' || !rr.routes?.length) throw new Error(rr.code);
    const r0 = rr.routes[0];
    const coordinates = r0.geometry?.coordinates;
    if (r0.geometry?.type !== 'LineString' || !Array.isArray(coordinates) || coordinates.length < 2 ||
        !coordinates.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) &&
          Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90)) {
      throw new Error('Invalid GeoJSON route geometry');
    }
    const stroke = { lineCap: 'round', lineJoin: 'round', bubblingMouseEvents: false };
    line = L.featureGroup([
      L.geoJSON(r0.geometry, { style: { ...stroke, color: '#fff', weight: 11, opacity: 0.96 } }),
      L.geoJSON(r0.geometry, { style: { ...stroke, color: '#e6397a', weight: 6, opacity: 1 } })
    ]);
    bounds = line.getBounds();
    if (!bounds.isValid()) throw new Error('Route geometry has invalid bounds');
    note = `Маршрут: ${fmtDist(r0.distance)}, ~${Math.max(1, Math.round(r0.duration / 60))} мин пешком`;
  } catch (error) {
    console.warn('[route] Routing API failed; showing straight-line fallback.', {
      reason: error?.message || String(error), name: error?.name
    });
    line = L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: '#e6397a', weight: 4, dashArray: '8 10', bubblingMouseEvents: false });
    bounds = line.getBounds();
    note = 'Маршрут по дорогам недоступен, показана прямая';
  } finally {
    clearTimeout(tm);
  }
  if (tok !== routeToken) return;                       // route was cancelled while loading
  routeLine = line.addTo(map); toast(note);
  if (fitView) {
    map.invalidateSize();
    map.fitBounds(bounds, { paddingTopLeft: [30, 60], paddingBottomRight: [70, 90], maxZoom: 17 });
  }
}
async function meet(ids) {
  const sel = ids ? ids.map((id) => [id, friends.get(id)]) : [...friends], card = $('#spotcard');
  const pts = [...(me.lat !== null ? [{ name: 'Я', lat: me.lat, lon: me.lon }] : []), ...sel.filter(([, f]) => f).map(([id, f]) => ({ name: prof(id).name, lat: f.lat, lon: f.lon }))];
  if (pts.length < 2) return toast('Нужны геопозиции минимум двух участников');
  const r = meetingPoint(pts), c = { lat: r.point.lat, lon: r.point.lon };
  clearRoute(); spotMarker?.remove();
  spotMarker = L.marker([c.lat, c.lon], { icon: spotIcon, zIndexOffset: 1000, title: 'Место встречи' }).addTo(map);
  const x = el('button', 'x', '×'); x.setAttribute('aria-label', 'Закрыть');
  x.onclick = () => { card.hidden = true; spotMarker?.remove(); spotMarker = null; clearRoute(); };
  card.replaceChildren(x, el('h2', '', 'Место встречи'), ...pts.map((p, i) => { const d = el('div', 'row'); d.append(el('span', '', p.name), el('span', 'r', `${fmtDist(r.dists[i])} · ${eta(r.dists[i])}`)); return d; }),
    el('small', '', `Суммарно ${fmtDist(r.total)}, самый дальний ${fmtDist(r.max)}`));
  card.hidden = false;
  fit([...pts.map((p) => [p.lat, p.lon]), [c.lat, c.lon]], true);
  if (me.lat !== null) route(me, c, false);
}
$('#meet').onclick = () => meet(null);

// ---------- own profile and diagnostics
function renderMe() {
  $('#mav-wrap').replaceChildren(avatar(mine, 'lg'));
  if (document.activeElement !== $('#pname')) $('#pname').value = mine.name || prof(me.id).name || '';
  if (document.activeElement !== $('#pbio')) $('#pbio').value = mine.bio;
  $('#sw').replaceChildren(...COLORS.map((c) => { const b = el('button', c === mine.color ? 'on' : ''); b.style.background = c; b.setAttribute('aria-label', 'Цвет ' + c); b.onclick = () => saveProfile({ color: c }); return b; }));
}
let saveTimer;
function saveProfile(patch) {
  Object.assign(mine, patch); store.set(mine); renderMe();
  me.marker?.setIcon(icon({ ...mine, name: 'Я' }));
  clearTimeout(saveTimer); saveTimer = setTimeout(() => send(T.PROFILE, json(mine), 1), 500);
}
$('#pname').oninput = (e) => saveProfile({ name: e.target.value });
$('#pbio').oninput = (e) => saveProfile({ bio: e.target.value });
function renderDiag() {
  const rows = [['SRTT', to.init ? to.srtt.toFixed(0) + ' мс' : '–'], ['RTO', to.rtoMs().toFixed(0) + ' мс'],
    ['Потери PING', stat.ping > 1 ? Math.max(0, Math.round((1 - stat.pong / (stat.ping - 1)) * 100)) + '%' : '–'],
    ['Ждут ACK', String(chan.pending.size)], ['Эмуляция', `loss ${LOSS * 100}%, lag ${LAG} мс, CSP ${CSP ? 'вкл' : 'выкл'}`]];
  $('#diag').replaceChildren(...rows.map(([a, b]) => { const d = el('div'); d.append(el('span', '', a), el('span', '', b)); return d; }));
  const pill = $('#pill'); pill.className = !key ? '' : to.init && to.rtoMs() > 1000 ? 'bad' : 'ok';
  pill.querySelector('span').textContent = !key ? 'Подключение…' : to.init ? `${to.srtt.toFixed(0)} мс` : 'Онлайн';
}
$('#pill').onclick = () => go('me');
$('#tp').onclick = () => (me.lat === null ? toast('Сначала отметьте позицию на карте') : moveTo(me.lat + 5, me.lon));
setInterval(renderDiag, 1000);

// ---------- map controls
let watch = null;
$('#gps').onclick = () => {
  if (watch !== null) { navigator.geolocation.clearWatch(watch); watch = null; $('#gps').classList.remove('on'); return toast('GPS выключен'); }
  watch = navigator.geolocation.watchPosition((p) => moveTo(p.coords.latitude, p.coords.longitude), () => toast('GPS недоступен'), { enableHighAccuracy: true });
  $('#gps').classList.add('on');
};
map.on('click', (e) => moveTo(e.latlng.lat, e.latlng.lng));
function renderAll() { renderFriends(); renderChats(); renderDialog(); renderMe(); renderDiag(); }
renderAll();
