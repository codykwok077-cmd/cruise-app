'use strict';
/**
 * Cruise server — zero dependencies, just Node 18+.
 *  - serves ./public
 *  - REST API for cruises (route + stops)
 *  - Server-Sent Events for live route + car positions
 * State lives in memory. Set DATA_FILE=/path/cruises.json to keep routes across restarts.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE || '';
const CRUISE_TTL = 48 * 3600 * 1000;   // forget cruises idle for 48h
const CAR_TTL = 90 * 1000;             // drop cars that stop reporting for 90s
const MAX_PHOTOS = 80;                 // per cruise
const MAX_PHOTO_BYTES = 40 * 1024 * 1024; // per cruise, all photos together
const MAX_FULL = 900 * 1024, MAX_THUMB = 80 * 1024;

const cruises = new Map();
let persistDirty = false;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.ico': 'image/x-icon'
};

/* ---------- persistence (optional) ---------- */
function load() {
  if (!DATA_FILE) return;
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const c of raw) cruises.set(c.code, { ...c, info: c.info || emptyInfo(), cars: new Map(), clients: new Set(), carsDirty: false, changed: new Set(), metaDirty: new Set(), gone: [], photos: [], photoBytes: 0 });
    console.log('Loaded', cruises.size, 'cruises');
  } catch (e) { /* first run */ }
}
function save() {
  if (!DATA_FILE || !persistDirty) return;
  persistDirty = false;
  const out = [...cruises.values()].map(({ code, name, adminKey, points, paths, steps, info, updated }) => ({ code, name, adminKey, points, paths, steps, info, updated }));
  fs.writeFile(DATA_FILE, JSON.stringify(out), err => { if (err) console.error('save failed', err.message); });
}

/* ---------- helpers ---------- */
function send(res, status, obj) {
  const body = obj == null ? '' : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
const str = (v, n) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f]/g, '').slice(0, n);
function genCode() {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  for (;;) {
    let s = ''; const b = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) s += a[b[i] % a.length];
    if (!cruises.has(s)) return s;
  }
}
function cleanPoints(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 300).map(p => {
    const lat = num(p && p.lat), lng = num(p && p.lng);
    if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat: +lat.toFixed(6), lng: +lng.toFixed(6), stop: !!p.stop, name: str(p.name, 40) };
  }).filter(Boolean);
}
function cleanPaths(arr, nPoints) {
  const want = Math.max(0, nPoints - 1);
  const out = [];
  for (let i = 0; i < want; i++) {
    const v = Array.isArray(arr) ? arr[i] : null;
    out.push(typeof v === 'string' && v.length < 200000 ? v : null);
  }
  return out;
}
function cleanSteps(arr, nPoints) {
  const want = Math.max(0, nPoints - 1), out = [];
  for (let i = 0; i < want; i++) {
    const seg = Array.isArray(arr) ? arr[i] : null;
    if (!Array.isArray(seg)) { out.push(null); continue; }
    out.push(seg.slice(0, 400).map(st => {
      const la = num(st && st.la), ln = num(st && st.ln);
      if (la == null || ln == null || Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
      const x = num(st.x), b = num(st.b);
      return {
        la: +la.toFixed(6), ln: +ln.toFixed(6), t: str(st.t, 24), m: str(st.m, 24), n: str(st.n, 60),
        d: Math.max(0, Math.round(num(st.d) || 0)), u: Math.max(0, Math.round(num(st.u) || 0)),
        x: x != null ? Math.max(0, Math.min(20, Math.round(x))) : null,
        b: b != null ? ((Math.round(b) % 360) + 360) % 360 : null
      };
    }).filter(Boolean));
  }
  return out;
}
const emptyInfo = () => ({ date: '', meet: '', end: '', notes: '' });
function cleanInfo(b) {
  b = b && typeof b === 'object' ? b : {};
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : '',
    meet: /^([01]\d|2[0-3]):[0-5]\d$/.test(b.meet) ? b.meet : '',
    end: /^([01]\d|2[0-3]):[0-5]\d$/.test(b.end) ? b.end : '',
    notes: (typeof b.notes === 'string' ? b.notes : '').replace(/[\u0000-\u0009\u000b-\u001f]/g, '').slice(0, 1000)
  };
}
const publicState = c => ({ code: c.code, name: c.name, points: c.points, paths: c.paths, steps: c.steps || [], info: c.info || emptyInfo() });
const carsList = c => [...c.cars.values()].map(({ id, name, color, lat, lng, hd, sp, t }) => ({ id, name, color, lat, lng, hd, sp, t }));
const photosMeta = c => c.photos.map(({ id, by, name, t, lat, lng }) => ({ id, by, name, t, lat, lng }));
function decodeJpeg(dataUrl, max) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/.exec(typeof dataUrl === 'string' ? dataUrl : '');
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length || buf.length > max) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;   // must really be a JPEG
  return buf;
}
function sse(res, event, data) {
  if (res.writableLength > 1_000_000) { res.destroy(); return; }   // a stuck or very slow phone must not pile up memory
  res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
}
function touch(c) { c.updated = Date.now(); persistDirty = true; }
function sameKey(a, b) {
  const A = Buffer.from(String(a || '')), B = Buffer.from(String(b || ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

/* ---------- API ---------- */
async function api(req, res, url) {
  const p = url.pathname;

  if (p === '/api/cruises' && req.method === 'POST') {
    const b = await readBody(req);
    const code = genCode();
    const c = {
      code, name: str(b.name, 40) || 'Sunday cruise', adminKey: crypto.randomBytes(16).toString('hex'),
      points: [], paths: [], steps: [], updated: Date.now(), cars: new Map(), clients: new Set(), carsDirty: false, changed: new Set(), metaDirty: new Set(), gone: [],
      photos: [], photoBytes: 0, info: emptyInfo()
    };
    cruises.set(code, c); persistDirty = true;
    return send(res, 201, { ...publicState(c), adminKey: c.adminKey });
  }

  const m = p.match(/^\/api\/cruises\/([a-z0-9]{4,10})(?:\/(events|pos|photos)(?:\/([a-f0-9]{8,24})(?:\/(thumb))?)?)?$/);
  if (!m) return send(res, 404, { error: 'not found' });
  const c = cruises.get(m[1]);
  if (!c) return send(res, 404, { error: 'no such cruise' });

  if (!m[2] && req.method === 'GET') return send(res, 200, publicState(c));

  if (!m[2] && req.method === 'PUT') {
    if (!sameKey(req.headers['x-admin-key'], c.adminKey)) return send(res, 403, { error: 'not the organiser' });
    const b = await readBody(req, 3_000_000);
    if (b.name !== undefined) c.name = str(b.name, 40) || c.name;
    if (b.points !== undefined) { c.points = cleanPoints(b.points); c.paths = cleanPaths(b.paths, c.points.length); c.steps = cleanSteps(b.steps, c.points.length); }
    if (b.info !== undefined) c.info = cleanInfo(b.info);
    touch(c);
    const state = publicState(c);
    for (const r of c.clients) sse(r, 'state', state);
    return send(res, 200, state);
  }

  if (m[2] === 'pos' && req.method === 'POST') {
    const b = await readBody(req, 4000);
    const id = str(b.id, 24);
    if (!id) return send(res, 400, { error: 'id required' });
    const lat = num(b.lat), lng = num(b.lng);
    const ok = lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    const name = str(b.name, 20) || 'Driver', color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#475569';
    const prev = c.cars.get(id);
    if (!prev || prev.name !== name || prev.color !== color) c.metaDirty.add(id);
    c.cars.set(id, { id, name, color, lat: ok ? lat : null, lng: ok ? lng : null, hd: num(b.hd), sp: num(b.sp), t: Date.now() });
    c.changed.add(id); c.updated = Date.now();
    return send(res, 204, null);
  }

  if (m[2] === 'events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    sse(res, 'state', publicState(c));
    sse(res, 'cars', carsList(c));
    sse(res, 'photos', photosMeta(c));
    c.clients.add(res);
    req.on('close', () => c.clients.delete(res));
    return;
  }

  if (m[2] === 'photos') {
    // upload
    if (!m[3] && req.method === 'POST') {
      const b = await readBody(req, 1_600_000);
      const full = decodeJpeg(b.image, MAX_FULL), thumb = decodeJpeg(b.thumb, MAX_THUMB);
      if (!full || !thumb) return send(res, 400, { error: 'photo must be a JPEG under the size limit' });
      if (c.photos.length >= MAX_PHOTOS) return send(res, 413, { error: 'This cruise has reached its photo limit' });
      if (c.photoBytes + full.length + thumb.length > MAX_PHOTO_BYTES) return send(res, 413, { error: 'This cruise has run out of photo space' });
      const lat = num(b.lat), lng = num(b.lng);
      const ok = lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
      const photo = {
        id: crypto.randomBytes(6).toString('hex'), token: crypto.randomBytes(12).toString('hex'),
        by: str(b.by, 24), name: str(b.name, 20) || 'Driver', t: Date.now(),
        lat: ok ? +lat.toFixed(6) : null, lng: ok ? +lng.toFixed(6) : null, full, thumb
      };
      c.photos.push(photo); c.photoBytes += full.length + thumb.length; c.updated = Date.now();
      const meta = photosMeta(c);
      for (const r of c.clients) sse(r, 'photos', meta);
      return send(res, 201, { id: photo.id, token: photo.token });
    }
    const ph = m[3] ? c.photos.find(x => x.id === m[3]) : null;
    // view
    if (m[3] && req.method === 'GET') {
      if (!ph) return send(res, 404, { error: 'no such photo' });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400, immutable', 'X-Content-Type-Options': 'nosniff' });
      return res.end(m[4] ? ph.thumb : ph.full);
    }
    // delete (uploader's token, or the organiser's key)
    if (m[3] && !m[4] && req.method === 'DELETE') {
      if (!ph) return send(res, 404, { error: 'no such photo' });
      const allowed = sameKey(req.headers['x-photo-token'], ph.token) || sameKey(req.headers['x-admin-key'], c.adminKey);
      if (!allowed) return send(res, 403, { error: 'not allowed' });
      c.photos = c.photos.filter(x => x !== ph); c.photoBytes -= ph.full.length + ph.thumb.length; c.updated = Date.now();
      const meta = photosMeta(c);
      for (const r of c.clients) sse(r, 'photos', meta);
      return send(res, 204, null);
    }
  }

  return send(res, 405, { error: 'method not allowed' });
}

/* ---------- static ---------- */
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep) && file !== PUB) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': /\.(png|ico)$/.test(file) ? 'public, max-age=86400' : 'no-cache'   // always pick up new versions of the app
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') return send(res, 200, { ok: true, cruises: cruises.size });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) send(res, 400, { error: 'bad request' }); else res.end();
  }
});

/* ---------- timers ---------- */
setInterval(() => {                       // push car positions once a second
  const now = Date.now();
  for (const c of cruises.values()) {
    for (const [id, car] of c.cars) if (now - car.t > CAR_TTL) { c.cars.delete(id); c.gone.push(id); c.changed.delete(id); }
    if (c.clients.size && (c.changed.size || c.gone.length)) {
      // compact delta: [id, lat, lng, heading, speed] for cars that moved; names/colours only when new or changed
      const u = [], m = {};
      for (const id of c.changed) {
        const car = c.cars.get(id); if (!car) continue;
        u.push([id, car.lat == null ? null : +car.lat.toFixed(5), car.lng == null ? null : +car.lng.toFixed(5), car.hd == null ? null : Math.round(car.hd), car.sp == null ? null : +car.sp.toFixed(1)]);
        if (c.metaDirty.has(id)) m[id] = [car.name, car.color];
      }
      const msg = { u, m, g: c.gone };
      for (const r of c.clients) sse(r, 'cd', msg);
    }
    c.changed.clear(); c.metaDirty.clear(); c.gone = [];
  }
}, 1000);
setInterval(() => { for (const c of cruises.values()) for (const r of c.clients) r.write(': ping\n\n'); }, 25000);
setInterval(() => {                       // forget idle cruises
  const now = Date.now();
  for (const [code, c] of cruises) if (!c.clients.size && now - c.updated > CRUISE_TTL) { cruises.delete(code); persistDirty = true; }
}, 600000);
setInterval(save, 30000);

load();
server.listen(PORT, () => console.log('Cruise running on http://localhost:' + PORT));
process.on('SIGTERM', () => { persistDirty = true; save(); process.exit(0); });
