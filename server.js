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
    for (const c of raw) cruises.set(c.code, { ...c, cars: new Map(), clients: new Set(), carsDirty: false });
    console.log('Loaded', cruises.size, 'cruises');
  } catch (e) { /* first run */ }
}
function save() {
  if (!DATA_FILE || !persistDirty) return;
  persistDirty = false;
  const out = [...cruises.values()].map(({ code, name, adminKey, points, paths, updated }) => ({ code, name, adminKey, points, paths, updated }));
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
const publicState = c => ({ code: c.code, name: c.name, points: c.points, paths: c.paths });
const carsList = c => [...c.cars.values()].map(({ id, name, color, lat, lng, hd, sp, t }) => ({ id, name, color, lat, lng, hd, sp, t }));
function sse(res, event, data) { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); }
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
      points: [], paths: [], updated: Date.now(), cars: new Map(), clients: new Set(), carsDirty: false
    };
    cruises.set(code, c); persistDirty = true;
    return send(res, 201, { ...publicState(c), adminKey: c.adminKey });
  }

  const m = p.match(/^\/api\/cruises\/([a-z0-9]{4,10})(?:\/(events|pos))?$/);
  if (!m) return send(res, 404, { error: 'not found' });
  const c = cruises.get(m[1]);
  if (!c) return send(res, 404, { error: 'no such cruise' });

  if (!m[2] && req.method === 'GET') return send(res, 200, publicState(c));

  if (!m[2] && req.method === 'PUT') {
    if (!sameKey(req.headers['x-admin-key'], c.adminKey)) return send(res, 403, { error: 'not the organiser' });
    const b = await readBody(req);
    if (b.name !== undefined) c.name = str(b.name, 40) || c.name;
    if (b.points !== undefined) { c.points = cleanPoints(b.points); c.paths = cleanPaths(b.paths, c.points.length); }
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
    c.cars.set(id, {
      id, name: str(b.name, 20) || 'Driver',
      color: /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#475569',
      lat: ok ? lat : null, lng: ok ? lng : null,
      hd: num(b.hd), sp: num(b.sp), t: Date.now()
    });
    c.carsDirty = true; c.updated = Date.now();
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
    c.clients.add(res);
    req.on('close', () => c.clients.delete(res));
    return;
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
      'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600'
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
    for (const [id, car] of c.cars) if (now - car.t > CAR_TTL) { c.cars.delete(id); c.carsDirty = true; }
    if (c.carsDirty && c.clients.size) { const list = carsList(c); for (const r of c.clients) sse(r, 'cars', list); }
    c.carsDirty = false;
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
