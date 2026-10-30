(function () {
'use strict';

const CFG = Object.assign({
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileAttribution: '&copy; OpenStreetMap contributors',
  osrmUrl: 'https://router.project-osrm.org',
  geocodeUrl: 'https://nominatim.openstreetmap.org/search',
  units: 'auto',   // 'auto' (miles in the US, otherwise km), 'metric' or 'imperial'
  // Main map: OpenFreeMap (free, no key). If it can't load, the app switches to the raster map above.
  vectorStyle: 'https://tiles.openfreemap.org/styles/liberty',
  vectorAttribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  vectorLoadTimeoutMs: 12000
}, window.CRUISE_CONFIG || {});

/* ---------- helpers ---------- */
const $ = (s, r) => (r || document).querySelector(s);
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const k in props) {
    const v = props[k];
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c && c.nodeType ? c : document.createTextNode(c));
  return e;
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const COLORS = ['#ff4d2e', '#2563eb', '#16a34a', '#9333ea', '#d97706', '#0891b2', '#db2777', '#475569'];
const hashStr = s => { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0; return x; };
const rad = d => d * Math.PI / 180;
function hav(a, b, c, d) {
  const dl = rad(c - a), dg = rad(d - b);
  const x = Math.sin(dl / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dg / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}
function bearing(a, b, c, d) {
  const y = Math.sin(rad(d - b)) * Math.cos(rad(c));
  const x = Math.cos(rad(a)) * Math.sin(rad(c)) - Math.sin(rad(a)) * Math.cos(rad(c)) * Math.cos(rad(d - b));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const fmtKm = m => m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
const fmtTime = s => { const m = Math.round(s / 60); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' m'; };
function genId() { return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6); }

function decodePoly(str) {
  let i = 0, lat = 0, lng = 0; const out = [];
  while (i < str.length) {
    let b, s = 0, r = 0;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << s; s += 5; } while (b >= 32);
    lat += (r & 1) ? ~(r >> 1) : (r >> 1);
    s = 0; r = 0;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << s; s += 5; } while (b >= 32);
    lng += (r & 1) ? ~(r >> 1) : (r >> 1);
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}
const decCache = new Map();
function decode(s) {
  let r = decCache.get(s);
  if (!r) { r = decodePoly(s); decCache.set(s, r); if (decCache.size > 600) decCache.delete(decCache.keys().next().value); }
  return r;
}

let toastT = null;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2800); }
function homeMsg(t) { $('#homeMsg').textContent = t || ''; }

/* ---------- state ---------- */
const S = {
  code: null, adminKey: null, isOrg: false, cname: '',
  points: [], paths: [], steps: [], cars: new Map(),
  mode: 'pan', sel: -1, snap: store.get('cruise_snap') !== '0',
  loaded: false, fitted: false, es: null, live: false,
  myId: null, nick: '', color: COLORS[0],
  me: { lat: null, lng: null, hd: null, sp: null, has: false },
  watchId: null, wake: null, wakeState: 'idle', wantAwake: false,
  demo: false, demoCars: [], active: false,
  photos: [], voice: store.get('cruise_voice') !== '0',
  info: { date: '', meet: '', end: '', notes: '' }
};

/* ---------- map ---------- */
let map, routeCasing, routeLine, pointLayer, carLayer, photoLayer, searchMarker = null, myEntry = null;
const carEntries = new Map();

function webglOK() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
}
function addRasterBase(m) { return L.tileLayer(CFG.tileUrl, { maxZoom: 19, attribution: CFG.tileAttribution }).addTo(m); }
// OpenFreeMap vector map first; if the plugin, WebGL or the tiles fail, fall back to the raster map.
function addBaseMap(m) {
  if (!CFG.vectorStyle || !L.maplibreGL || !window.maplibregl || !webglOK()) { addRasterBase(m); return 'raster'; }
  let gl = null, switched = false;
  const toRaster = () => {
    if (switched) return; switched = true;
    try { if (gl) m.removeLayer(gl); } catch (e) {}
    addRasterBase(m); toast('Using the backup map');
  };
  try {
    gl = L.maplibreGL({ style: CFG.vectorStyle, attribution: CFG.vectorAttribution }).addTo(m);
    const ml = gl.getMaplibreMap && gl.getMaplibreMap();
    if (!ml) { toRaster(); return 'raster'; }
    let loaded = false; const errTimes = [];
    ml.on('load', () => { loaded = true; });
    ml.on('error', () => {
      const now = Date.now(); errTimes.push(now);
      while (errTimes.length && now - errTimes[0] > 20000) errTimes.shift();
      if ((!loaded && errTimes.length >= 3) || errTimes.length >= 40) toRaster();
    });
    setTimeout(() => { if (!loaded) toRaster(); }, CFG.vectorLoadTimeoutMs || 12000);
    return 'vector';
  } catch (e) { toRaster(); return 'raster'; }
}
function initMap() {
  if (map) { setTimeout(() => map.invalidateSize(), 50); return; }
  map = L.map('map', { zoomControl: false, minZoom: 2, maxZoom: 19 }).setView([20, 0], 2);
  addBaseMap(map);
  map.attributionControl.setPrefix(false);
  routeCasing = L.polyline([], { color: '#fff', weight: 11, opacity: .95, lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(map);
  routeLine = L.polyline([], { color: '#ff4d2e', weight: 5, lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(map);
  pointLayer = L.layerGroup().addTo(map);
  photoLayer = L.layerGroup().addTo(map);
  carLayer = L.layerGroup().addTo(map);
  map.on('click', onMapClick);
  map.on('zoomstart', () => { if (!FOL.busy) FOL.userZoomed = true; });
  const labels = () => $('#map').classList.toggle('labels-off', map.getZoom() < 15);
  map.on('zoomend', labels); labels();
  window.addEventListener('resize', () => map.invalidateSize());
}

/* ---------- route geometry ---------- */
function segCoords(i) {
  const a = S.points[i], b = S.points[i + 1], p = S.paths[i];
  return p ? decode(p) : [[a.lat, a.lng], [b.lat, b.lng]];
}
function routeCoords() {
  const out = [];
  for (let i = 0; i < S.points.length - 1; i++) { const s = segCoords(i); for (let k = 0; k < s.length; k++) out.push(s[k]); }
  return out;
}
function routeStats() {
  const at = [0]; let total = 0;
  for (let i = 0; i < S.points.length - 1; i++) {
    const s = segCoords(i);
    for (let k = 1; k < s.length; k++) total += hav(s[k - 1][0], s[k - 1][1], s[k][0], s[k][1]);
    at.push(total);
  }
  return { total, at };
}

function pointIcon(p, i, n) {
  const last = i === S.points.length - 1 && S.points.length > 1;
  let cls = 'pin', txt = '';
  if (p.stop) { cls += ' stop'; txt = String(n); }
  else if (i === 0) { cls += ' start'; txt = 'S'; }
  else if (last) { cls += ' finish'; txt = 'F'; }
  else cls += ' way';
  if (i === S.sel) cls += ' sel';
  return L.divIcon({ className: 'pt', html: h('div', { class: cls, text: txt }), iconSize: [0, 0] });
}

function drawRoute() {
  if (!map) return;
  const coords = routeCoords();
  routeCasing.setLatLngs(coords); routeLine.setLatLngs(coords);
  pointLayer.clearLayers();
  let n = 0;
  S.points.forEach((p, i) => {
    if (p.stop) n++;
    const m = L.marker([p.lat, p.lng], { icon: pointIcon(p, i, n), draggable: S.isOrg, keyboard: false, zIndexOffset: p.stop ? 300 : 100 });
    if (p.stop && p.name) m.bindTooltip(h('span', { text: p.name }), { permanent: true, direction: 'right', offset: [18, 0], className: 'lbl' });
    m.on('click', () => { S.sel = i; renderRoute(); drawRoute(); showTab('Route'); });
    m.on('dragend', () => {
      const ll = m.getLatLng(); p.lat = +ll.lat.toFixed(6); p.lng = +ll.lng.toFixed(6);
      if (i > 0) { S.paths[i - 1] = null; S.steps[i - 1] = null; snap(i - 1); }
      if (i < S.points.length - 1) { S.paths[i] = null; S.steps[i] = null; snap(i); }
      changed();
    });
    pointLayer.addLayer(m);
  });
}

/* ---------- editing ---------- */
let snapWarned = false;
function compactSteps(steps) {
  return (steps || []).map(st => {
    const m = st.maneuver || {}, loc = m.location || [];
    if (loc.length < 2) return null;
    return { la: +(+loc[1]).toFixed(6), ln: +(+loc[0]).toFixed(6), t: m.type || '', m: m.modifier || '',
      n: String(st.name || st.ref || '').slice(0, 60), d: Math.round(st.distance || 0), u: Math.round(st.duration || 0),
      x: m.exit != null ? m.exit : null, b: m.bearing_after != null ? m.bearing_after : null };
  }).filter(Boolean).slice(0, 400);
}
function fixSteps() { while (S.steps.length < S.paths.length) S.steps.push(null); if (S.steps.length > S.paths.length) S.steps.length = S.paths.length; }
async function snap(i) {
  if (!S.snap) return;
  const a = S.points[i], b = S.points[i + 1];
  if (!a || !b) return;
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 8000);
  try {
    const url = CFG.osrmUrl + '/route/v1/driving/' + a.lng + ',' + a.lat + ';' + b.lng + ',' + b.lat + '?overview=full&geometries=polyline&steps=true';
    const r = await fetch(url, { signal: ctl.signal });
    const d = await r.json();
    if (d.code !== 'Ok' || !d.routes || !d.routes[0]) throw new Error('no route');
    const geom = d.routes[0].geometry, steps = compactSteps(d.routes[0].legs && d.routes[0].legs[0] && d.routes[0].legs[0].steps);
    const idx = S.points.indexOf(a);
    if (idx >= 0 && S.points[idx + 1] === b && geom.length < 150000) { S.paths[idx] = geom; S.steps[idx] = steps; changed(); }
  } catch (e) {
    if (!snapWarned) { snapWarned = true; toast('Couldn’t snap to roads — drawing a straight line'); }
  } finally { clearTimeout(to); }
}

function addPoint(ll) {
  S.points.push({ lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6), stop: false, name: '' });
  if (S.points.length > 1) { S.paths.push(null); S.steps.push(null); snap(S.points.length - 2); }
  S.sel = -1; changed();
}
function addStop(ll, name) {
  const pt = { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6), stop: true, name: (name || '').slice(0, 40) };
  if (S.points.length < 2) {
    if (!name) { toast('Draw at least two route points first'); return false; }
    S.points.push(pt);
    if (S.points.length > 1) { S.paths.push(null); S.steps.push(null); snap(S.points.length - 2); }
    S.sel = S.points.length - 1; changed(); showTab('Route');
    return true;
  }
  const tap = map.latLngToLayerPoint(ll);
  let best = 0, bd = Infinity;
  for (let i = 0; i < S.points.length - 1; i++) {
    const s = segCoords(i);
    for (let k = 1; k < s.length; k++) {
      const d = L.LineUtil.pointToSegmentDistance(tap, map.latLngToLayerPoint(s[k - 1]), map.latLngToLayerPoint(s[k]));
      if (d < bd) { bd = d; best = i; }
    }
  }
  S.points.splice(best + 1, 0, pt);
  S.paths.splice(best, 1, null, null); S.steps.splice(best, 1, null, null);
  snap(best); snap(best + 1);
  S.sel = best + 1; changed(); showTab('Route');
  if (!name) toast('Stop added — name it in the Route tab');
  return true;
}
function removePoint(j) {
  S.points.splice(j, 1);
  if (S.points.length === 0) { S.paths = []; S.steps = []; }
  else if (j === 0) { S.paths.shift(); S.steps.shift(); }
  else if (j >= S.points.length) { S.paths.pop(); S.steps.pop(); }
  else { S.paths.splice(j - 1, 2, null); S.steps.splice(j - 1, 2, null); snap(j - 1); }
  S.sel = -1; changed();
}
function onMapClick(e) {
  if (!S.isOrg) return;
  if (S.mode === 'route') addPoint(e.latlng);
  else if (S.mode === 'stop') addStop(e.latlng);
  else if (S.sel !== -1) { S.sel = -1; drawRoute(); renderRoute(); }
}

/* ---------- saving ---------- */
let saveT = null, saving = false, pendingSave = false;
function changed() { drawRoute(); renderRoute(); updateTools(); scheduleSave(); scheduleRecent(); }
function scheduleSave() { if (!S.isOrg || !S.code) return; clearTimeout(saveT); saveT = setTimeout(flushSave, 500); }
async function flushSave() {
  if (saving) { pendingSave = true; return; }
  saving = true;
  try {
    const r = await fetch('/api/cruises/' + S.code, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-admin-key': S.adminKey },
      body: JSON.stringify({ name: S.cname, points: S.points, paths: S.paths, steps: S.steps, info: S.info })
    });
    if (r.status === 403) toast('You’re not the organiser of this cruise');
    else if (!r.ok) toast('Couldn’t save the route');
  } catch (e) { toast('Offline — route will save when you’re back online'); pendingSave = true; setTimeout(() => { if (pendingSave) { pendingSave = false; flushSave(); } }, 5000); }
  saving = false;
  if (pendingSave && navigator.onLine !== false) { pendingSave = false; flushSave(); }
}

/* ---------- panels ---------- */
function showTab(name) {
  ['Route', 'Info', 'People', 'Share', 'Photos'].forEach(n => { $('#panel' + n).hidden = n !== name; });
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  $('#sheet').classList.remove('collapsed');
  if (name === 'People') renderPeople();
  if (name === 'Share') renderShare();
  if (name === 'Photos') renderPhotos();
  if (name === 'Info') renderInfo();
}
function flyTo(lat, lng, z) { if (map) map.flyTo([lat, lng], Math.max(map.getZoom(), z || 15), { duration: .6 }); }

function renderRoute() {
  const el = $('#panelRoute'); el.replaceChildren();
  const { total, at } = routeStats(), pts = S.points;
  const stops = pts.filter(p => p.stop).length;
  el.append(h('div', { class: 'stats' },
    h('div', { class: 'stat' }, h('b', { text: pts.length > 1 ? fmtKm(total) : '—' }), h('small', { text: 'Distance' })),
    h('div', { class: 'stat' }, h('b', { text: String(stops) }), h('small', { text: 'Stops' })),
    h('div', { class: 'stat' }, h('b', { text: pts.length > 1 ? fmtTime(total / (50 / 3.6)) : '—' }), h('small', { text: 'Drive at 50 km/h' }))
  ));
  if (S.isOrg && S.snap && pts.length > 1 && S.paths.some((p, i) => !p || !S.steps[i])) {
    el.append(h('button', { class: 'outline', style: 'margin:0 0 8px', text: 'Add turn directions for voice guidance', onclick: refreshDirections }));
  }
  if (!pts.length) {
    el.append(h('p', { class: 'empty', text: S.isOrg ? 'No route yet. Pick Route above, then tap the map to lay out your cruise. Switch to Stop to drop stops along it.' : 'The organiser hasn’t drawn a route yet. It will appear here live.' }));
    return;
  }
  let n = 0;
  pts.forEach((p, i) => {
    const isStart = i === 0 && !p.stop, isEnd = i === pts.length - 1 && !p.stop && pts.length > 1;
    if (p.stop) n++;
    if (!p.stop && !isStart && !isEnd) return;
    const color = p.stop ? '#ff4d2e' : isStart ? '#16a34a' : '#12151a';
    const info = h('div', { class: 'grow' });
    if (p.stop && S.isOrg) {
      info.append(h('input', { value: p.name || '', placeholder: 'Stop ' + n, maxlength: '40', 'aria-label': 'Stop name',
        onchange: e => { p.name = e.target.value.trim().slice(0, 40); changed(); } }));
    } else info.append(h('b', { text: p.stop ? (p.name || 'Stop ' + n) : isStart ? 'Start' : 'Finish' }));
    info.append(h('small', { text: i === 0 ? '0 m' : fmtKm(at[i]) + ' from start' }));
    const row = h('div', { class: 'item' + (i === S.sel ? ' sel' : '') },
      h('span', { class: 'badge', style: 'background:' + color, text: p.stop ? String(n) : (isStart ? 'S' : 'F') }), info,
      h('button', { class: 'mini', 'aria-label': 'Show on map', text: '⌖', onclick: () => { S.sel = i; drawRoute(); flyTo(p.lat, p.lng, 15); } }));
    if (p.stop && S.isOrg) row.append(h('button', { class: 'mini', 'aria-label': 'Remove stop', text: '✕', onclick: () => removePoint(i) }));
    el.append(row);
  });
}

function carList() {
  const list = [{ id: S.myId, name: S.nick, color: S.color, car: S.car, isMe: true, lat: S.me.lat, lng: S.me.lng, has: S.me.has, sp: S.me.sp, t: Date.now() }];
  S.cars.forEach(c => { if (c.id !== S.myId) list.push({ ...c, has: c.lat != null }); });
  S.demoCars.forEach(c => list.push({ ...c, has: true, demo: true }));
  return list;
}
function renderPeople() {
  const el = $('#panelPeople'); if (el.hidden) return;
  el.replaceChildren();
  const list = carList(), now = Date.now();
  list.forEach(c => {
    let sub;
    if (!c.has) sub = 'No GPS yet';
    else if (!c.isMe && !c.demo && now - c.t > 45000) sub = 'Idle · seen ' + Math.max(1, Math.round((now - c.t) / 60000)) + ' min ago';
    else sub = c.sp != null && c.sp >= 1 ? Math.round(c.sp * 3.6) + ' km/h' : 'Stopped';
    if (c.demo) sub += ' · demo';
    const row = h('div', { class: 'item' },
      h('span', { class: 'badge', style: 'background:' + c.color, text: (c.name || '?').charAt(0).toUpperCase() }),
      h('div', { class: 'grow' }, h('b', { text: c.isMe ? c.name + ' (you)' : c.name }), h('small', { text: (c.car ? c.car + ' · ' : '') + sub })));
    if (c.has) row.append(h('button', { class: 'mini', 'aria-label': 'Show on map', text: '⌖', onclick: () => flyTo(c.lat, c.lng, 15) }));
    el.append(row);
  });
  if (list.length === 1) el.append(h('p', { class: 'empty', text: 'Just you so far. Share the link and cars will appear here as people join.' }));
  el.append(h('button', { class: 'outline', onclick: openProfile, text: 'Edit my profile' }));
  if (S.isOrg && S.points.length > 1) el.append(h('button', { class: 'outline', onclick: toggleDemo, text: S.demo ? 'Stop demo cars' : 'Preview with demo cars' }));
}

function joinLink() { return location.origin + '/?c=' + S.code; }
function renderShare() {
  const el = $('#panelShare'); el.replaceChildren();
  el.append(
    h('div', { class: 'code', text: (S.code || '').toUpperCase() }),
    h('p', { class: 'sub', text: 'Friends can type this code on the home screen, or open the link.' }),
    h('input', { id: 'linkInput', readonly: true, value: joinLink(), 'aria-label': 'Join link' }),
    h('div', { class: 'btnrow' },
      h('button', { class: 'primary', onclick: () => copy(joinLink()), text: 'Copy link' }),
      navigator.share ? h('button', { class: 'ghost', onclick: () => { navigator.share({ title: S.cname, text: 'Join my cruise', url: joinLink() }).catch(() => {}); }, text: 'Share…' }) : null),
    h('button', { class: 'outline', onclick: () => copy((S.code || '').toUpperCase()), text: 'Copy code' })
  );
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch (e) { const i = $('#linkInput'); try { if (i) { i.focus(); i.select(); } document.execCommand('copy'); toast('Copied'); } catch (_) { toast('Press and hold to copy'); } }
}

/* ---------- toolbar / chips ---------- */
function updateTools() {
  $('#tools').hidden = !S.isOrg;
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
  $('#snapBtn').textContent = 'Roads: ' + (S.snap ? 'On' : 'Off');
  const hint = $('#hint');
  if (S.isOrg && S.mode === 'route') { hint.textContent = 'Tap the map to add route points'; hint.hidden = false; }
  else if (S.isOrg && S.mode === 'stop') { hint.textContent = S.points.length < 2 ? 'Draw a route first' : 'Tap near the route to drop a stop'; hint.hidden = false; }
  else hint.hidden = true;
  $('#undoBtn').disabled = !S.points.length;
  $('#startNav').hidden = S.points.length < 2;
}
function updateChips() {
  const others = [...S.cars.keys()].filter(id => id !== S.myId).length;
  $('#liveDot').className = 'dot' + (S.live ? '' : ' off');
  $('#cSub').textContent = (S.code || '').toUpperCase() + ' · ' + (S.live ? (1 + others + S.demoCars.length) + ' live' : 'connecting…');
  $('#cTitle').textContent = S.cname || 'Cruise';
}
function setAwakeChip() {
  const chip = $('#awakeChip'), dot = chip.querySelector('.dot'), txt = chip.querySelector('span');
  if (S.wakeState === 'on') { dot.className = 'dot'; txt.textContent = 'Screen stays on'; }
  else if (S.wakeState === 'unsupported') { dot.className = 'dot off'; txt.textContent = 'Keep-awake unavailable'; }
  else { dot.className = 'dot warn'; txt.textContent = 'Tap: keep screen on'; }
}

/* ---------- wake lock ---------- */
async function acquireWake() {
  S.wantAwake = true;
  if (!('wakeLock' in navigator)) { S.wakeState = 'unsupported'; setAwakeChip(); return; }
  try {
    if (S.wake && !S.wake.released) { S.wakeState = 'on'; setAwakeChip(); return; }
    S.wake = await navigator.wakeLock.request('screen');
    S.wakeState = 'on';
    S.wake.addEventListener('release', () => { S.wakeState = 'idle'; setAwakeChip(); });
  } catch (e) { S.wakeState = (e && e.name === 'NotAllowedError') ? 'idle' : 'idle'; }
  setAwakeChip();
}
function releaseWake() { S.wantAwake = false; try { S.wake && S.wake.release(); } catch (e) {} S.wake = null; S.wakeState = 'idle'; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.active && S.wantAwake) acquireWake(); });
$('#awakeChip').addEventListener('click', () => {
  if (S.wakeState === 'on') { toast('Screen will stay on while the app is open'); return; }
  acquireWake().then(() => { if (S.wakeState !== 'on') toast('Your browser refused keep-awake. Turn off auto-lock in phone settings.'); });
});

/* ---------- cars on the map ---------- */
function makeCarEntry(lat, lng) {
  const lab = h('div', { class: 'lab' }), arr = h('div', { class: 'arr' }), dot = h('div', { class: 'cdot' });
  const el = h('div', { class: 'carwrap' }, lab, arr, dot);
  const pop = h('div', { class: 'cpop' }, h('b'), h('span', { class: 'ccar' }), h('small'));
  const marker = L.marker([lat, lng], { icon: L.divIcon({ className: 'car', html: el, iconSize: [0, 0] }), interactive: true, keyboard: false, zIndexOffset: 800 }).addTo(carLayer);
  marker.bindPopup(pop, { closeButton: false, autoPan: false, offset: [0, -16] });
  return { marker, el, lab, arr, dot, pop };
}
function updateCarEntry(e, c, isMe) {
  e.lab.textContent = isMe ? 'You' : c.name;
  e.dot.style.background = c.color; e.dot.textContent = (c.name || '?').charAt(0).toUpperCase();
  e.arr.style.borderBottomColor = c.color;
  e.arr.style.display = c.hd == null ? 'none' : 'block';
  if (c.hd != null) e.arr.style.transform = 'rotate(' + c.hd + 'deg)';
  e.el.classList.toggle('me', !!isMe);
  e.pop.children[0].textContent = isMe ? c.name + ' (you)' : c.name;
  e.pop.children[1].textContent = c.car || '';
  e.pop.children[2].textContent = c.sp != null && c.sp >= 1 ? Math.round(c.sp * 3.6) + ' km/h' : '';
  e.marker.setLatLng([c.lat, c.lng]);
}
function syncCars() {
  if (!map) return;
  const want = new Map();
  S.cars.forEach(c => { if (c.id !== S.myId && c.lat != null) want.set(c.id, c); });
  S.demoCars.forEach(c => want.set(c.id, c));
  for (const [id, e] of carEntries) if (!want.has(id)) { carLayer.removeLayer(e.marker); carEntries.delete(id); }
  want.forEach((c, id) => { let e = carEntries.get(id); if (!e) { e = makeCarEntry(c.lat, c.lng); carEntries.set(id, e); } updateCarEntry(e, c, false); });
  if (S.me.has) {
    if (!myEntry) myEntry = makeCarEntry(S.me.lat, S.me.lng);
    updateCarEntry(myEntry, { name: S.nick, color: S.color, car: S.car, sp: S.me.sp, lat: S.me.lat, lng: S.me.lng, hd: S.me.hd }, true);
  }
}
function clearCars() {
  if (carLayer) carLayer.clearLayers();
  carEntries.clear(); myEntry = null;
}

/* demo cars */
let demoT = null;
function toggleDemo() {
  S.demo = !S.demo;
  clearInterval(demoT);
  if (S.demo) {
    S.demoCars = ['Mia', 'Jack', 'Priya', 'Leo'].map((n, i) => ({ id: 'demo' + i, name: n, car: ['Mazda MX-5', 'Ford Ranger', 'VW Golf GTI', 'Toyota 86'][i], color: COLORS[(i + 1) % COLORS.length], sp: 14 + i * 2.5, off: i * 80, lat: 0, lng: 0, hd: null }));
    const tick = () => {
      const coords = routeCoords(); if (coords.length < 2) return;
      const cum = [0]; for (let k = 1; k < coords.length; k++) cum.push(cum[k - 1] + hav(coords[k - 1][0], coords[k - 1][1], coords[k][0], coords[k][1]));
      const tot = cum[cum.length - 1] || 1, now = Date.now() / 1000;
      S.demoCars.forEach(c => {
        const d = (((now * c.sp + c.off) % tot) + tot) % tot; let k = 1; while (k < cum.length - 1 && cum[k] < d) k++;
        const t = (d - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1), a = coords[k - 1], b = coords[k];
        c.lat = a[0] + (b[0] - a[0]) * t; c.lng = a[1] + (b[1] - a[1]) * t; c.hd = bearing(a[0], a[1], b[0], b[1]);
      });
      syncCars();
    };
    tick(); demoT = setInterval(tick, 1000);
  } else { S.demoCars = []; syncCars(); }
  renderPeople(); updateChips();
}

/* ---------- live connection ---------- */
function onState(st) {
  const first = !S.loaded;
  if (S.isOrg && !first) return;                 // organiser is the source of truth
  S.cname = st.name || S.cname;
  S.points = Array.isArray(st.points) ? st.points : [];
  S.paths = Array.isArray(st.paths) ? st.paths : [];
  S.steps = Array.isArray(st.steps) ? st.steps : []; fixSteps();
  S.info = Object.assign({ date: '', meet: '', end: '', notes: '' }, st.info || {});
  S.loaded = true;
  renderInfo();
  if (first && !S.isOrg && hasInfo(S.info)) showTab('Info');
  drawRoute(); renderRoute(); updateTools(); updateChips(); scheduleRecent();
  const sig = JSON.stringify(S.points.map(p => [p.lat, p.lng, p.stop ? 1 : 0])) + JSON.stringify(S.paths.map(p => p ? p.length : 0));
  if (NAV.on && NAV.sig && sig !== NAV.sig) { toast('The organiser changed the route'); const rt = buildRoute(); if (rt) beginNav(rt, false, sig); else endNav(false); }
  if (S.points.length && !S.fitted) { S.fitted = true; fitAll(); }
}
function onCarDelta(d) {
  const now = Date.now();
  (d.g || []).forEach(id => S.cars.delete(id));
  Object.keys(d.m || {}).forEach(id => {
    const car = S.cars.get(id) || { id, lat: null, lng: null, hd: null, sp: null };
    car.car = String(d.m[id][2] || '').slice(0, 40); car.name = String(d.m[id][0] || 'Driver').slice(0, 20); car.color = /^#[0-9a-f]{6}$/i.test(d.m[id][1]) ? d.m[id][1] : '#475569';
    S.cars.set(id, car);
  });
  (d.u || []).forEach(r => {
    const car = S.cars.get(r[0]) || { id: r[0], name: 'Driver', color: '#475569' };
    car.lat = r[1]; car.lng = r[2]; car.hd = r[3]; car.sp = r[4]; car.t = now;
    S.cars.set(r[0], car);
  });
  syncCars(); updateChips(); renderPeople();
}
function onCars(list) {
  S.cars = new Map(list.map(c => [c.id, c]));
  syncCars(); updateChips(); renderPeople();
}
function connect() {
  const es = new EventSource('/api/cruises/' + S.code + '/events');
  es.addEventListener('state', e => onState(JSON.parse(e.data)));
  es.addEventListener('cars', e => onCars(JSON.parse(e.data)));
  es.addEventListener('cd', e => onCarDelta(JSON.parse(e.data)));
  es.addEventListener('photos', e => onPhotos(JSON.parse(e.data)));
  es.onopen = () => { S.live = true; updateChips(); postPos(true); };
  es.onerror = () => { S.live = false; updateChips(); };
  S.es = es;
}
let lastPost = 0, postTimer = null, lastPosted = null;
function postPos(force) {
  if (!S.code) return;
  const m = S.me;
  const still = m.has && lastPosted && (m.sp == null || m.sp < 1) && hav(lastPosted.lat, lastPosted.lng, m.lat, m.lng) < 4;
  const now = Date.now(), wait = (still ? 8000 : 2000) - (now - lastPost);   // parked cars only check in every few seconds
  if (!force && wait > 0) { if (!postTimer) postTimer = setTimeout(() => { postTimer = null; postPos(true); }, wait); return; }
  lastPost = now; if (m.has) lastPosted = { lat: m.lat, lng: m.lng };
  fetch('/api/cruises/' + S.code + '/pos', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
    body: JSON.stringify({ id: S.myId, name: S.nick, color: S.color, car: S.car, lat: m.has ? m.lat : null, lng: m.has ? m.lng : null, hd: m.hd, sp: m.sp })
  }).catch(() => {});
}
setInterval(() => { if (S.active) { postPos(true); renderPeople(); } }, 10000);

/* ---------- GPS ---------- */
let lastFix = null;
function startGeo() {
  if (!navigator.geolocation) { return; }
  $('#locating').hidden = false;
  S.watchId = navigator.geolocation.watchPosition(pos => {
    const c = pos.coords, m = S.me, first = !m.has;
    if (c.heading != null && isFinite(c.heading) && (c.speed || 0) > 0.8) m.hd = c.heading;
    else if (lastFix && hav(lastFix.lat, lastFix.lng, c.latitude, c.longitude) > 8) { m.hd = bearing(lastFix.lat, lastFix.lng, c.latitude, c.longitude); lastFix = { lat: c.latitude, lng: c.longitude }; }
    if (!lastFix) lastFix = { lat: c.latitude, lng: c.longitude };
    m.lat = c.latitude; m.lng = c.longitude; m.has = true;
    m.sp = (c.speed != null && isFinite(c.speed)) ? c.speed : null;
    if (first) {
      $('#locating').hidden = true;
      if (!S.points.length && !S.fitted && map) map.setView([m.lat, m.lng], 15);
    }
    syncCars(); postPos(false);
    if (NAV.on) navFix(m.lat, m.lng, m.sp);
    followTick(m.lat, m.lng, m.sp);
  }, err => {
    $('#locating').hidden = true;
    toast(err && err.code === 1 ? 'Location is blocked — allow it to show up on the map' : 'Couldn’t get your location');
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 25000 });
}

function fitAll() {
  if (!map) return;
  const pts = routeCoords().slice();
  if (!pts.length) S.points.forEach(p => pts.push([p.lat, p.lng]));
  carEntries.forEach(e => { const ll = e.marker.getLatLng(); pts.push([ll.lat, ll.lng]); });
  if (S.me.has) pts.push([S.me.lat, S.me.lng]);
  if (!pts.length) return;
  const sheetH = $('#sheet').offsetHeight;
  map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [40, 130], paddingBottomRight: [40, sheetH + 70], maxZoom: 17 });
}

/* ---------- lifecycle ---------- */
function enterCruise() {
  $('#home').hidden = true; $('#cruise').hidden = false; S.active = true;
  S.mode = 'pan'; S.sel = -1; S.loaded = false; S.fitted = false; S.cars = new Map(); S.live = false;
  S.isOrg = !!S.adminKey;
  history.replaceState(null, '', '/?c=' + S.code);
  initMap(); clearCars();
  updateTools(); updateChips(); renderRoute(); renderShare(); showTab('Route');
  setTimeout(() => { map.invalidateSize(); drawRoute(); }, 60);
  connect(); startGeo(); acquireWake();
}
function leaveCruise() {
  saveRecentNow();
  S.active = false;
  if (S.es) S.es.close(); S.es = null;
  if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId); S.watchId = null;
  releaseWake(); clearInterval(demoT); S.demo = false; S.demoCars = [];
  FOL.drivingUntil = 0; FOL.userZoomed = false; FOL.last = null;
  endNav(false); updateFollowUI(); S.points = []; S.paths = []; S.steps = []; S.code = null; S.adminKey = null; S.isOrg = false; S.cars = new Map();
  S.me = { lat: null, lng: null, hd: null, sp: null, has: false }; lastFix = null;
  clearCars(); if (map) { routeCasing.setLatLngs([]); routeLine.setLatLngs([]); pointLayer.clearLayers(); photoLayer.clearLayers(); }
  S.info = { date: '', meet: '', end: '', notes: '' }; S.photos = []; { const pt = document.querySelector('#tabs [data-tab="Photos"]'); if (pt) pt.textContent = 'Photos'; } closeSearch(); clearSearchMarker(); closeLightbox(); $('#searchResults').replaceChildren(); $('#searchInput').value = '';
  history.replaceState(null, '', '/');
  $('#cruise').hidden = true; $('#home').hidden = false; $('#locating').hidden = true;
  renderRecent();
}
async function startCruise(route) {
  homeMsg(''); applyProfile();
  const saved = route && Array.isArray(route.points) ? route : null;
  const name = $('#cname').value.trim().slice(0, 40) || (saved ? String(saved.name || '').slice(0, 40) : '') || 'Sunday cruise';
  const body = { name };
  if (saved) { body.points = saved.points; body.paths = saved.paths; body.steps = saved.steps; }
  try {
    const r = await fetch('/api/cruises', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error();
    const d = await r.json();
    S.code = d.code; S.cname = d.name; S.adminKey = d.adminKey;
    store.set('cruise_admin_' + d.code, d.adminKey);
    enterCruise();
  } catch (e) { homeMsg('Couldn’t reach the server. Check your connection and try again.'); }
}
async function joinCruise(codeIn) {
  homeMsg(''); applyProfile();
  const code = (codeIn || $('#joinCode').value).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (code.length < 4) { homeMsg('Enter the cruise code.'); return; }
  try {
    const r = await fetch('/api/cruises/' + code);
    if (r.status === 404) { homeMsg('No cruise with that code.'); return; }
    if (!r.ok) throw new Error();
    const d = await r.json();
    S.code = d.code; S.cname = d.name; S.adminKey = store.get('cruise_admin_' + d.code) || null;
    enterCruise();
  } catch (e) { homeMsg('Couldn’t reach the server. Check your connection and try again.'); }
}

/* ---------- cruise info (meet / end / details) ---------- */
const hasInfo = i => !!(i && (i.date || i.meet || i.end || i.notes));
function fmtClock(t) {
  if (!/^\d{2}:\d{2}$/.test(t || '')) return '';
  try { return new Date(2000, 0, 1, +t.slice(0, 2), +t.slice(3)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return t; }
}
function fmtDay(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return '';
  const [y, m, dd] = d.split('-').map(Number);
  try { return new Date(y, m - 1, dd).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }); } catch (e) { return d; }
}
function setInfo(key, val) { S.info[key] = val; scheduleSave(); }
function renderInfo() {
  const el = $('#panelInfo'); if (el.hidden) return;
  el.replaceChildren();
  const i = S.info;
  if (S.isOrg) {
    el.append(
      h('div', { class: 'frow one' }, h('label', { text: 'Date' }, h('input', { type: 'date', value: i.date || '', onchange: e => setInfo('date', e.target.value) }))),
      h('div', { class: 'frow' },
        h('label', { text: 'Meet at' }, h('input', { type: 'time', value: i.meet || '', onchange: e => setInfo('meet', e.target.value) })),
        h('label', { text: 'Ends at' }, h('input', { type: 'time', value: i.end || '', onchange: e => setInfo('end', e.target.value) }))),
      h('label', { text: 'Details' }, h('textarea', { maxlength: '1000', placeholder: 'Where to park, rules, what to bring, radio channel…',
        oninput: e => setInfo('notes', e.target.value.slice(0, 1000)) }, i.notes || '')),
      h('p', { class: 'sub', style: 'margin-top:10px', text: 'Everyone in the cruise sees this and it updates live.' }));
    return;
  }
  if (!hasInfo(i)) { el.append(h('p', { class: 'empty', text: 'The organiser hasn’t added any details yet. They’ll show up here.' })); return; }
  const day = fmtDay(i.date), meet = fmtClock(i.meet), end = fmtClock(i.end);
  const box = (lab, val) => h('div', { class: 'tbox' }, h('small', { text: lab }), h('b', { text: val }));
  el.append(h('div', { class: 'infocard' },
    day ? h('div', { class: 'infoday', text: day }) : null,
    (meet || end) ? h('div', { class: 'times' }, meet ? box('Meet at', meet) : null, end ? box('Ends at', end) : null) : null));
  if (i.notes) el.append(h('p', { class: 'notes', text: i.notes }));
}

/* ---------- place search (side drawer) ---------- */
let lastSearch = 0, searching = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function openSearch() { $('#searchDrawer').classList.add('open'); setTimeout(() => $('#searchInput').focus(), 250); }
function closeSearch() { $('#searchDrawer').classList.remove('open'); }
function clearSearchMarker() { if (searchMarker && map) { map.removeLayer(searchMarker); } searchMarker = null; }
function showSearchMarker(lat, lng) {
  clearSearchMarker();
  searchMarker = L.marker([lat, lng], { icon: L.divIcon({ className: 'pt', html: h('div', { class: 'pin search' }), iconSize: [0, 0] }), interactive: false, zIndexOffset: 900 }).addTo(map);
}
async function runSearch(q) {
  q = q.trim();
  const box = $('#searchResults');
  if (q.length < 2 || searching) return;
  searching = true; $('#searchGo').disabled = true;
  box.replaceChildren(h('p', { class: 'empty', text: 'Searching…' }));
  try {
    const wait = 1100 - (Date.now() - lastSearch);   // public geocoder allows ~1 request per second
    if (wait > 0) await sleep(wait);
    lastSearch = Date.now();
    const params = new URLSearchParams({ q, format: 'jsonv2', limit: '8', 'accept-language': navigator.language || 'en' });
    if (map && map.getZoom() >= 8) { const b = map.getBounds(); params.set('viewbox', [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].join(',')); }
    const r = await fetch(CFG.geocodeUrl + '?' + params.toString(), { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error();
    const list = await r.json();
    renderResults(Array.isArray(list) ? list : []);
  } catch (e) {
    box.replaceChildren(h('p', { class: 'empty', text: 'Search isn’t available right now. Check your connection and try again.' }));
  }
  searching = false; $('#searchGo').disabled = false;
}
function renderResults(list) {
  const box = $('#searchResults'); box.replaceChildren();
  if (!list.length) { box.append(h('p', { class: 'empty', text: 'No places found. Try a different name or add a suburb.' })); return; }
  list.forEach(res => {
    const lat = parseFloat(res.lat), lng = parseFloat(res.lon);
    if (!isFinite(lat) || !isFinite(lng)) return;
    const full = String(res.display_name || '');
    const title = String(res.name || full.split(',')[0] || 'Place').slice(0, 60);
    const rest = full.split(',').slice(1).join(',').trim().slice(0, 120);
    const row = h('div', { class: 'result' },
      h('button', { class: 'rtext', onclick: () => { showSearchMarker(lat, lng); flyTo(lat, lng, 16); if (window.innerWidth < 700) closeSearch(); } },
        h('b', { text: title }), h('small', { text: rest })));
    if (S.isOrg) {
      row.append(h('div', { class: 'ractions' },
        h('button', { class: 'outline sm', text: 'Add as stop', onclick: () => {
          if (addStop({ lat, lng }, title)) { clearSearchMarker(); toast('Added “' + title + '” as a stop'); flyTo(lat, lng, 15); if (window.innerWidth < 700) closeSearch(); }
        } }),
        h('button', { class: 'outline sm', text: 'Add to route', onclick: () => {
          addPoint({ lat, lng }); clearSearchMarker(); toast('Added to the route'); flyTo(lat, lng, 15); if (window.innerWidth < 700) closeSearch();
        } })));
    }
    box.append(row);
  });
  if (!S.isOrg) box.append(h('p', { class: 'empty', text: 'Only the organiser can add places to the route. Tap a result to see it on the map.' }));
}

/* ---------- photos ---------- */
const photoUrl = (p, thumb) => '/api/cruises/' + S.code + '/photos/' + p.id + (thumb ? '/thumb' : '');
const fmtWhen = t => { try { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } };

function onPhotos(list) {
  S.photos = Array.isArray(list) ? list : [];
  const tab = document.querySelector('#tabs [data-tab="Photos"]');
  if (tab) tab.textContent = 'Photos' + (S.photos.length ? ' ' + S.photos.length : '');
  renderPhotos(); syncPhotoPins();
  if (lbIndex >= 0) { if (!S.photos.length || !S.photos.find(p => p.id === lbId)) closeLightbox(); }
}
function renderPhotos() {
  const el = $('#panelPhotos'); if (el.hidden) return;
  el.replaceChildren(
    h('div', { class: 'btnrow', style: 'margin:8px 0 12px' },
      h('button', { class: 'primary', text: 'Take photo', onclick: () => $('#cameraInput').click() }),
      h('button', { class: 'ghost', text: 'Choose photos', onclick: () => $('#photoInput').click() })));
  if (!S.photos.length) { el.append(h('p', { class: 'empty', text: 'No photos yet. Photos you take during the cruise are pinned where you took them.' })); return; }
  const grid = h('div', { class: 'pgrid' });
  [...S.photos].reverse().forEach(p => {
    grid.append(h('button', { class: 'ph', 'aria-label': 'Photo by ' + p.name, onclick: () => openLightbox(p.id) },
      h('img', { src: photoUrl(p, true), alt: 'Photo by ' + p.name, loading: 'lazy' })));
  });
  el.append(grid);
}
function syncPhotoPins() {
  if (!photoLayer) return;
  photoLayer.clearLayers();
  S.photos.forEach(p => {
    if (p.lat == null || p.lng == null) return;
    const el = h('div', { class: 'phpin' }, h('img', { src: photoUrl(p, true), alt: '' }));
    const m = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: 'pt', html: el, iconSize: [0, 0] }), keyboard: false, zIndexOffset: 200 });
    m.on('click', () => openLightbox(p.id));
    photoLayer.addLayer(m);
  });
}

function loadBitmap(file) {
  if (window.createImageBitmap) return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => loadImg(file));
  return loadImg(file);
}
function loadImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}
function encodeJpeg(src, max, q) {
  const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight, k = Math.min(1, max / Math.max(w0, h0));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
}
async function prepareImage(file) {
  const src = await loadBitmap(file);
  let full = null;
  for (const [max, q] of [[1280, .78], [1024, .66], [800, .6], [640, .55]]) {
    full = encodeJpeg(src, max, q);
    if ((full.length - 23) * 0.75 < 880 * 1024) break;
  }
  const thumb = encodeJpeg(src, 320, .7);
  if (src.close) try { src.close(); } catch (e) {}
  return { full, thumb };
}
async function uploadPhotos(files) {
  const list = [...files].filter(f => /^image\//.test(f.type) || !f.type).slice(0, 10);
  if (!list.length) return;
  let ok = 0;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    toast('Uploading ' + (i + 1) + ' of ' + list.length + '…');
    try {
      const { full, thumb } = await prepareImage(f);
      const fresh = S.me.has && f.lastModified && Date.now() - f.lastModified < 15 * 60 * 1000;   // taken just now: pin it here
      const r = await fetch('/api/cruises/' + S.code + '/photos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: S.nick, by: S.myId, lat: fresh ? S.me.lat : null, lng: fresh ? S.me.lng : null, image: full, thumb })
      });
      if (r.status === 413) { const d = await r.json().catch(() => ({})); toast(d.error || 'This cruise is out of photo space'); break; }
      if (!r.ok) throw new Error();
      const d = await r.json(); store.set('cruise_ptok_' + d.id, d.token); ok++;
    } catch (e) { toast('Couldn’t upload that photo'); }
  }
  if (ok) toast(ok === 1 ? 'Photo added' : ok + ' photos added');
}

/* lightbox */
let lbIndex = -1, lbId = null, lbArm = null;
function openLightbox(id) {
  const i = S.photos.findIndex(p => p.id === id); if (i < 0) return;
  lbIndex = i; lbId = id;
  const p = S.photos[i];
  $('#lbImg').src = photoUrl(p, false); $('#lbImg').alt = 'Photo by ' + p.name;
  $('#lbCap').textContent = p.name + ' · ' + fmtWhen(p.t) + (S.photos.length > 1 ? '  (' + (i + 1) + '/' + S.photos.length + ')' : '');
  const canDelete = S.isOrg || !!store.get('cruise_ptok_' + p.id);
  $('#lbDelete').hidden = !canDelete; $('#lbDelete').textContent = 'Delete'; if (lbArm) { clearTimeout(lbArm); lbArm = null; }
  $('#lbMap').hidden = p.lat == null;
  $('#lbPrev').hidden = $('#lbNext').hidden = S.photos.length < 2;
  $('#lightbox').hidden = false;
}
function closeLightbox() { $('#lightbox').hidden = true; lbIndex = -1; lbId = null; $('#lbImg').removeAttribute('src'); }
function stepLightbox(d) { if (lbIndex < 0 || S.photos.length < 2) return; openLightbox(S.photos[(lbIndex + d + S.photos.length) % S.photos.length].id); }
async function deleteCurrentPhoto() {
  const p = S.photos[lbIndex]; if (!p) return;
  const btn = $('#lbDelete');
  if (!lbArm) { btn.textContent = 'Sure?'; lbArm = setTimeout(() => { lbArm = null; btn.textContent = 'Delete'; }, 3000); return; }
  clearTimeout(lbArm); lbArm = null;
  const headers = {}, tok = store.get('cruise_ptok_' + p.id);
  if (tok) headers['x-photo-token'] = tok;
  if (S.isOrg && S.adminKey) headers['x-admin-key'] = S.adminKey;
  try {
    const r = await fetch('/api/cruises/' + S.code + '/photos/' + p.id, { method: 'DELETE', headers });
    if (!r.ok && r.status !== 404) throw new Error();
    store.del('cruise_ptok_' + p.id); closeLightbox(); toast('Photo deleted');
  } catch (e) { toast('Couldn’t delete that photo'); btn.textContent = 'Delete'; }
}

/* ---------- turn-by-turn navigation with voice ---------- */
const NAV = { on: false, route: null, coords: null, cum: null, man: null, total: 0, dur: 0, mi: 0, lastIdx: 0, s: 0,
  offCount: 0, rerouting: false, lastReroute: 0, offset: 0, startIdx: 0, finishing: false, sig: '' };
const useMiles = CFG.units === 'imperial' || (CFG.units !== 'metric' && /^en-US/i.test(navigator.language || ''));
const ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const lcFirst = s => s.charAt(0).toLowerCase() + s.slice(1);

function fmtNavDist(m) {
  if (useMiles) {
    const ft = m * 3.28084;
    if (ft < 1000) return Math.max(10, Math.round(ft / 50) * 50) + ' ft';
    const mi = m / 1609.344; return (mi < 10 ? mi.toFixed(1) : Math.round(mi)) + ' mi';
  }
  if (m < 100) return Math.max(10, Math.round(m / 10) * 10) + ' m';
  if (m < 1000) return Math.round(m / 50) * 50 + ' m';
  const km = m / 1000; return (km < 10 ? km.toFixed(1) : Math.round(km)) + ' km';
}
function sayDist(m) {
  if (useMiles) {
    const ft = m * 3.28084;
    if (ft < 1000) return Math.max(100, Math.round(ft / 100) * 100) + ' feet';
    const mi = m / 1609.344; return mi < 10 ? (Math.round(mi * 10) / 10) + ' miles' : Math.round(mi) + ' miles';
  }
  if (m < 1000) return Math.max(50, Math.round(m / 50) * 50) + ' metres';
  const km = m / 1000; return (km < 10 ? km.toFixed(1) : Math.round(km)) + ' kilometres';
}
const sideOf = mod => /left/.test(mod || '') ? 'left' : /right/.test(mod || '') ? 'right' : '';
function manText(m) {
  const road = m.name ? ' onto ' + m.name : '', mod = m.mod || '', side = sideOf(mod);
  const turnWord = { 'slight left': 'slightly left', 'slight right': 'slightly right' }[mod] || mod;
  switch (m.type) {
    case 'depart': return 'Head ' + COMPASS[Math.round((m.b || 0) / 45) % 8] + (m.name ? ' on ' + m.name : '');
    case 'arrive': return m.isStop ? 'You have arrived at ' + (m.stopName || 'stop ' + m.stopNo) : 'You have arrived at the finish';
    case 'roundabout': case 'rotary': return 'At the roundabout, take the ' + (ORD[(m.exit || 1) - 1] || (m.exit + 'th')) + ' exit' + road;
    case 'merge': return 'Merge' + road;
    case 'on ramp': return 'Take the ramp' + (side ? ' on the ' + side : '') + road;
    case 'off ramp': return 'Take the exit' + (side ? ' on the ' + side : '') + road;
    case 'fork': return side ? 'Keep ' + side + road : 'Continue straight' + road;
    case 'new name': return 'Continue' + road;
    case 'continue': return mod && mod !== 'straight' && mod !== 'uturn' ? 'Continue ' + turnWord + road : 'Continue straight' + road;
    default:
      if (mod === 'uturn') return 'Make a U-turn' + (m.name ? ' on ' + m.name : '');
      if (!mod || mod === 'straight') return 'Continue straight' + road;
      return 'Turn ' + turnWord + road;
  }
}
function manIcon(m) {
  if (m.type === 'arrive') return { g: '⚑', r: 0 };
  if (m.type === 'roundabout' || m.type === 'rotary') return { g: '↻', r: 0 };
  const rot = { 'straight': 0, 'slight right': 35, 'right': 90, 'sharp right': 140, 'uturn': 180, 'sharp left': -140, 'left': -90, 'slight left': -35 }[m.mod];
  return { g: '↑', r: rot == null ? 0 : rot };
}
const isMinor = m => (m.type === 'new name' || m.type === 'continue') && (!m.mod || m.mod === 'straight');

/* voice */
let speakId = 0, speaking = false, pendingSay = null;
function unlockSpeech() {
  try { if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis.speak(u); } } catch (e) {}
}
function doSay(text) {
  const id = ++speakId, u = new SpeechSynthesisUtterance(text);
  u.lang = navigator.language || 'en-US';
  const done = () => { if (id !== speakId) return; speaking = false; if (pendingSay) { const t = pendingSay; pendingSay = null; doSay(t); } };
  u.onend = done; u.onerror = done; speaking = true;
  window.speechSynthesis.speak(u);
}
function say(text, urgent) {
  if (!S.voice || !('speechSynthesis' in window)) return;
  try {
    if (speaking) {
      if (urgent) { speakId++; window.speechSynthesis.cancel(); speaking = false; pendingSay = null; doSay(text); }
      else pendingSay = text;
      return;
    }
    doSay(text);
  } catch (e) {}
}
function setVoice(on) {
  S.voice = on; store.set('cruise_voice', on ? '1' : '0');
  $('#navMute').textContent = on ? 'Voice on' : 'Muted';
  if (!on) { try { speakId++; window.speechSynthesis.cancel(); speaking = false; pendingSay = null; } catch (e) {} }
}

/* geometry helpers */
function segProject(lat, lng, a, b) {
  const kx = 111320 * Math.cos(rad(lat)), ky = 110540;
  const ax = (a[1] - lng) * kx, ay = (a[0] - lat) * ky, bx = (b[1] - lng) * kx, by = (b[0] - lat) * ky;
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? (-ax * dx - ay * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return { t, off: Math.hypot(ax + t * dx, ay + t * dy) };
}
function cumOf(coords) { const c = [0]; for (let i = 1; i < coords.length; i++) c.push(c[i - 1] + hav(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1])); return c; }
function advanceIdx(route, r, meters) { let k = r; while (k < route.coords.length - 1 && route.cum[k] - route.cum[r] < meters) k++; return k; }

function stepsToMan(steps, coords, from, to, o) {
  const out = []; let cur = from;
  (steps || []).forEach(st => {
    const t = st.t;
    if (t === 'arrive' || t === 'notification' || t === 'exit roundabout' || t === 'exit rotary') return;
    if (t === 'depart' && !o.depart) return;
    let best = cur, bd = Infinity;
    for (let k = cur; k <= to; k++) { const d = hav(coords[k][0], coords[k][1], st.la, st.ln); if (d < bd) { bd = d; best = k; } }
    cur = best;
    out.push({ idx: best, type: t, mod: st.m, name: st.n, exit: st.x, b: st.b });
  });
  return out;
}

function buildRoute() {
  const pts = S.points; if (pts.length < 2) return null;
  const coords = [], man = [], segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = segCoords(i), startIdx = coords.length ? coords.length - 1 : 0;
    for (let k = coords.length ? 1 : 0; k < seg.length; k++) coords.push(seg[k]);
    const endIdx = coords.length - 1, steps = S.steps[i];
    segs.push({ startIdx, endIdx, steps });
    stepsToMan(steps, coords, startIdx, endIdx, { depart: i === 0 }).forEach(m => man.push(m));
    const dest = pts[i + 1], last = i === pts.length - 2;
    if (dest.stop || last) man.push({ idx: endIdx, type: 'arrive', isStop: !!dest.stop, last, stopName: dest.name || '', stopNo: pts.slice(0, i + 2).filter(p => p.stop).length });
  }
  const cum = cumOf(coords);
  let dur = 0;
  segs.forEach(sg => { dur += sg.steps && sg.steps.length ? sg.steps.reduce((t, s) => t + (s.u || 0), 0) : (cum[sg.endIdx] - cum[sg.startIdx]) / 13.9; });
  man.forEach(m => { m.ms = cum[m.idx]; });
  return { coords, cum, man, total: cum[cum.length - 1] || 1, dur };
}
function nearestOnRoute(route, lat, lng) {
  let best = { off: Infinity, i: 0, s: 0 };
  for (let i = 0; i < route.coords.length - 1; i++) {
    const p = segProject(lat, lng, route.coords[i], route.coords[i + 1]);
    if (p.off < best.off) best = { off: p.off, i, s: route.cum[i] + p.t * (route.cum[i + 1] - route.cum[i]) };
  }
  return best;
}
function compose(route, approach, startIdx) {
  let coords, offset; const man = [];
  if (approach) {
    coords = approach.coords.slice(); approach.man.forEach(m => man.push({ ...m }));
    offset = coords.length - startIdx;
    for (let k = startIdx; k < route.coords.length; k++) coords.push(route.coords[k]);
  } else { offset = -startIdx; coords = route.coords.slice(startIdx); }
  route.man.forEach(m => { if (m.idx >= startIdx) man.push({ ...m, idx: m.idx + offset }); });
  const cum = cumOf(coords);
  man.forEach(m => { m.ms = cum[m.idx]; m.a1 = m.a2 = m.a3 = false; });
  Object.assign(NAV, { route, coords, cum, man, total: cum[cum.length - 1] || 1, offset, startIdx, mi: 0, lastIdx: 0, s: 0, offCount: 0,
    dur: (approach ? approach.dur : 0) + route.dur * Math.max(0, (route.total - route.cum[startIdx]) / route.total) });
}
async function fetchLeg(a, b) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 8000);
  try {
    const url = CFG.osrmUrl + '/route/v1/driving/' + a.lng + ',' + a.lat + ';' + b.lng + ',' + b.lat + '?overview=full&geometries=polyline&steps=true';
    const r = await fetch(url, { signal: ctl.signal }), d = await r.json();
    if (d.code !== 'Ok' || !d.routes || !d.routes[0]) throw new Error('no route');
    const rt = d.routes[0], coords = decodePoly(rt.geometry), steps = compactSteps(rt.legs && rt.legs[0] && rt.legs[0].steps);
    return { coords, man: stepsToMan(steps, coords, 0, coords.length - 1, { depart: true }), dur: steps.reduce((t, s) => t + (s.u || 0), 0) };
  } finally { clearTimeout(to); }
}

function projectNav(lat, lng) {
  const c = NAV.coords, cum = NAV.cum;
  const i0 = Math.max(0, NAV.lastIdx - 2), limit = cum[Math.min(NAV.lastIdx, c.length - 1)] + 4000;
  let best = { off: Infinity, s: cum[i0] || 0, idx: i0 };
  for (let i = i0; i < c.length - 1; i++) {
    if (cum[i] > limit && i > i0 + 30) break;
    const p = segProject(lat, lng, c[i], c[i + 1]);
    if (p.off < best.off) best = { off: p.off, s: cum[i] + p.t * (cum[i + 1] - cum[i]), idx: i };
  }
  return best;
}

function navHud() {
  if (!NAV.man || !NAV.man.length) return;
  const m = NAV.man[Math.min(NAV.mi, NAV.man.length - 1)], d = Math.max(0, m.ms - NAV.s);
  const ic = manIcon(m);
  $('#navGlyph').textContent = ic.g; $('#navGlyph').style.transform = 'rotate(' + ic.r + 'deg)';
  $('#navDist').textContent = fmtNavDist(d);
  $('#navInstr').textContent = manText(m);
  const n = NAV.man[NAV.mi + 1];
  $('#navThen').textContent = n && n.ms - m.ms < 400 ? 'Then ' + lcFirst(manText(n)) : '';
  const rem = Math.max(0, NAV.total - NAV.s), t = NAV.dur * (rem / NAV.total);
  $('#navTime').textContent = fmtTime(t);
  let eta = ''; try { eta = new Date(Date.now() + t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) {}
  $('#navMeta').textContent = fmtNavDist(rem) + (eta ? ' · ' + eta : '');
}
/* follow-me: always on while you're driving (navigating, or moving at speed). No switch. */
const FOL = { drivingUntil: 0, userZoomed: false, busy: false, last: null };
const isDriving = () => NAV.on || Date.now() < FOL.drivingUntil;
function updateFollowUI() { $('#locate').classList.toggle('active', isDriving()); }
function followMe(lat, lng, speed) {
  if (!map || !isDriving()) return;
  const kmh = (speed || 0) * 3.6;
  const z = FOL.userZoomed ? map.getZoom() : (NAV.on ? (kmh < 25 ? 18 : kmh < 70 ? 17 : 16) : Math.max(map.getZoom(), 16));
  let target = [lat, lng];
  if (NAV.on) {   // sit the car in the lower part of the screen so you see the road ahead
    const size = map.getSize(), p = map.project([lat, lng], z), ll = map.unproject({ x: p.x, y: p.y - size.y * 0.14 }, z);
    target = [ll.lat, ll.lng];
  }
  const cur = map.getCenter ? map.getCenter() : null;
  if (FOL.last && Math.abs(FOL.last.z - z) < 0.01 && (!cur || hav(cur.lat, cur.lng, target[0], target[1]) < 2)) return;
  FOL.last = { lat: target[0], lng: target[1], z };
  FOL.busy = true; map.setView(target, z, { animate: true, duration: .8 });
  setTimeout(() => { FOL.busy = false; }, 1000);
}
function followTick(lat, lng, speed) {   // called on every GPS fix
  if (speed != null && speed > 5) FOL.drivingUntil = Date.now() + 60000;   // moving at ~18 km/h or more = driving; stays on through a red light
  updateFollowUI(); followMe(lat, lng, speed);
}
function navFix(lat, lng, speed) {
  if (!NAV.on || !NAV.coords || NAV.finishing) return;
  const pr = projectNav(lat, lng);
  NAV.s = pr.s; NAV.lastIdx = pr.idx;
  NAV.offCount = pr.off > 80 ? NAV.offCount + 1 : 0;
  if (NAV.offCount >= 3 && !NAV.rerouting && Date.now() - NAV.lastReroute > 20000) reroute(lat, lng);
  let m = NAV.man[NAV.mi];
  while (m && NAV.s >= m.ms - (m.type === 'arrive' ? 25 : 15)) {
    if (m.type === 'arrive' && !m.a3) { m.a3 = true; say(manText(m), true); }
    NAV.mi++; m = NAV.man[NAV.mi];
  }
  if (!m) { NAV.finishing = true; navHud(); setTimeout(() => endNav(true), 6000); return; }
  if (NAV.offCount < 2) {
    const v = Math.max(0, speed || 0), d = m.ms - NAV.s, prev = NAV.mi > 0 ? NAV.man[NAV.mi - 1].ms : 0, gap = m.ms - prev;
    const far = Math.max(500, v * 30), mid = Math.max(200, v * 12), near = Math.max(m.type === 'arrive' ? 60 : 45, v * 4), quiet = isMinor(m);
    if (d <= near && !m.a3) { m.a3 = m.a2 = m.a1 = true; if (!quiet) say(manText(m), m.type !== 'depart'); }
    else if (m.type === 'arrive') {
      if (d <= Math.max(400, v * 20) && !m.a1 && gap > 600) { m.a1 = true; say('In ' + sayDist(d) + ', you will arrive at ' + (m.isStop ? (m.stopName || 'stop ' + m.stopNo) : 'the finish'), false); }
    }
    else if (!quiet && m.type !== 'depart') {
      if (d <= mid && !m.a2 && gap > mid + 120) { m.a2 = m.a1 = true; say('In ' + sayDist(d) + ', ' + lcFirst(manText(m)), false); }
      else if (d <= far && !m.a1 && gap > far + 150) { m.a1 = true; say('In ' + sayDist(d) + ', ' + lcFirst(manText(m)), false); }
    }
  }
  navHud();
}
async function reroute(lat, lng) {
  NAV.rerouting = true; NAV.lastReroute = Date.now();
  say('Off route. Recalculating.', true); $('#navInstr').textContent = 'Recalculating…';
  try {
    const r = NAV.route, rCur = Math.max(NAV.startIdx, NAV.lastIdx - NAV.offset);
    let best = rCur, bd = Infinity;
    for (let k = Math.max(0, rCur - 3); k < r.coords.length; k++) { const d = hav(lat, lng, r.coords[k][0], r.coords[k][1]); if (d < bd) { bd = d; best = k; } }
    const target = advanceIdx(r, best, 120);
    const leg = await fetchLeg({ lat, lng }, { lat: r.coords[target][0], lng: r.coords[target][1] });
    if (!NAV.on) return;
    compose(r, leg, target); navHud();
  } catch (e) { toast('Couldn’t recalculate. Follow the route line on the map.'); }
  NAV.rerouting = false;
}
async function beginNav(route, announce, sig) {
  const me = { lat: S.me.lat, lng: S.me.lng };
  const near = nearestOnRoute(route, me.lat, me.lng);
  let startIdx = near.i, approach = null;
  if (near.off > 70) {
    startIdx = near.off <= 600 ? advanceIdx(route, near.i, 120) : 0;
    try { approach = await fetchLeg(me, { lat: route.coords[startIdx][0], lng: route.coords[startIdx][1] }); }
    catch (e) { toast('Couldn’t get directions to the route. Follow the line on the map.'); }
  }
  compose(route, approach, startIdx);
  NAV.sig = sig || (JSON.stringify(S.points.map(p => [p.lat, p.lng, p.stop ? 1 : 0])) + JSON.stringify(S.paths.map(p => p ? p.length : 0)));
  NAV.on = true; NAV.finishing = false; NAV.rerouting = false; NAV.lastReroute = 0; FOL.userZoomed = false; FOL.last = null;
  $('#cruise').classList.add('driving'); $('#navTop').hidden = false; $('#navBottom').hidden = false;
  $('#sheet').classList.add('collapsed');
  updateFollowUI(); if (S.me.has) followMe(S.me.lat, S.me.lng, S.me.sp);
  setVoice(S.voice);
  if (announce) say(approach ? 'Starting route. Head to the start point.' : 'Starting route.', true); else say('Route updated.', true);
  const first = NAV.man[0];
  if (announce && first && first.type === 'depart') { first.a1 = first.a2 = first.a3 = true; say(manText(first), false); }
  navHud(); navFix(me.lat, me.lng, S.me.sp);
}
async function startNav() {
  if (NAV.on) return;
  const route = buildRoute();
  if (!route) { toast('Draw a route first'); return; }
  if (!S.me.has) { toast('Waiting for your GPS. Make sure location is allowed.'); return; }
  unlockSpeech();
  if (!S.steps.some(x => x && x.length)) toast('No turn directions on this route, so you’ll hear stop arrivals only.');
  const b = $('#startNav'); b.disabled = true;
  try { await beginNav(route, true); } finally { b.disabled = false; }
}
function endNav(arrived) {
  if (!NAV.on) return;
  NAV.on = false; NAV.finishing = false;
  $('#cruise').classList.remove('driving'); $('#navTop').hidden = true; $('#navBottom').hidden = true; updateFollowUI();
  try { if (!arrived) { speakId++; window.speechSynthesis.cancel(); speaking = false; pendingSay = null; } } catch (e) {}
  updateTools();
}
async function refreshDirections() {
  toast('Adding turn directions…');
  for (let i = 0; i < S.points.length - 1; i++) {
    if (!S.paths[i] || !S.steps[i]) { await snap(i); await new Promise(r => setTimeout(r, 300)); }
  }
}

/* ---------- profile (name, car, colour) ---------- */
const P = { name: '', car: '', color: null };
function applyProfile() {
  S.nick = P.name.trim().slice(0, 20) || 'Driver';
  S.car = P.car.trim().slice(0, 40);
  S.color = P.color || COLORS[hashStr(S.myId) % COLORS.length];
}
function loadProfile() {
  try {
    const p = JSON.parse(store.get('cruise_profile') || 'null');
    if (p && typeof p === 'object') { P.name = String(p.name || '').slice(0, 20); P.car = String(p.car || '').slice(0, 40); P.color = /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : null; }
    else P.name = (store.get('cruise_nick') || '').slice(0, 20);
  } catch (e) {}
  applyProfile();
}
function renderProfileCard() {
  $('#pfAvatar').textContent = (P.name.trim() || '?').charAt(0).toUpperCase();
  $('#pfAvatar').style.background = S.color;
  $('#pfName').textContent = P.name.trim() || 'Add your name';
  $('#pfCar').textContent = P.car.trim() || 'Add your car';
}
function saveProfile() {
  store.set('cruise_profile', JSON.stringify(P)); applyProfile(); renderProfileCard();
  if (S.active) { syncCars(); renderPeople(); postPos(false); }
}
function renderSwatches() {
  const box = $('#pfColors'); box.replaceChildren();
  COLORS.forEach(c => box.append(h('button', { class: 'sw' + (S.color === c ? ' on' : ''), style: 'background:' + c, 'aria-label': 'Marker colour ' + c,
    onclick: () => { P.color = c; saveProfile(); renderSwatches(); } })));
}
function openProfile() {
  $('#pfNameIn').value = P.name; $('#pfCarIn').value = P.car; renderSwatches();
  $('#profileModal').hidden = false; setTimeout(() => $('#pfNameIn').focus(), 60);
}
function closeProfile() { $('#profileModal').hidden = true; }

/* ---------- recent routes (kept on this phone) ---------- */
const RECENT_KEY = 'cruise_recent_v1';
function loadRecent() {
  try { const l = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(l) ? l.filter(r => r && Array.isArray(r.points) && r.points.length > 1 && r.sig) : []; }
  catch (e) { return []; }
}
function storeRecent(list) {
  const l = list.slice(0, 10);
  for (;;) { try { localStorage.setItem(RECENT_KEY, JSON.stringify(l)); return; } catch (e) { if (!l.length) return; l.pop(); } }   // phone storage full: drop the oldest
}
const routeSig = pts => pts.map(p => [(+p.lat).toFixed(5), (+p.lng).toFixed(5), p.stop ? 1 : 0, p.name || ''].join(',')).join('|');
let recentT = null;
function scheduleRecent() { clearTimeout(recentT); recentT = setTimeout(saveRecentNow, 30000); }
function saveRecentNow() {
  clearTimeout(recentT);
  if (!S.code || S.points.length < 2) return;
  const sig = routeSig(S.points), list = loadRecent().filter(r => r.sig !== sig);
  list.unshift({ sig, name: S.cname || 'Route', savedAt: Date.now(), points: S.points, paths: S.paths, steps: S.steps });
  storeRecent(list);
}
function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
  const hh = Math.round(m / 60); if (hh < 24) return hh + ' h ago';
  const d = Math.round(hh / 24); return d + (d === 1 ? ' day ago' : ' days ago');
}
function routeLenOf(r) {
  let t = 0;
  for (let i = 0; i < r.points.length - 1; i++) {
    const p = r.paths && r.paths[i];
    const seg = p ? decode(p) : [[r.points[i].lat, r.points[i].lng], [r.points[i + 1].lat, r.points[i + 1].lng]];
    for (let k = 1; k < seg.length; k++) t += hav(seg[k - 1][0], seg[k - 1][1], seg[k][0], seg[k][1]);
  }
  return t;
}
function renderRecent() {
  const box = $('#recentBox'); box.replaceChildren();
  const list = loadRecent(); box.hidden = !list.length;
  if (!list.length) return;
  box.append(h('div', { class: 'secthead', text: 'Recent routes' }));
  list.forEach(r => {
    const stops = r.points.filter(p => p.stop).length;
    box.append(h('div', { class: 'item' },
      h('div', { class: 'grow' }, h('b', { text: String(r.name || 'Route').slice(0, 40) }),
        h('small', { text: fmtKm(routeLenOf(r)) + ' · ' + stops + (stops === 1 ? ' stop' : ' stops') + ' · ' + ago(r.savedAt) })),
      h('button', { class: 'ghost sm', text: 'Use', onclick: () => startCruise(r) }),
      h('button', { class: 'mini', 'aria-label': 'Delete saved route', text: '✕', onclick: () => { storeRecent(loadRecent().filter(x => x.sig !== r.sig)); renderRecent(); } })));
  });
}

/* ---------- wiring ---------- */
$('#startBtn').addEventListener('click', () => startCruise());
$('#joinBtn').addEventListener('click', () => joinCruise());
$('#joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinCruise(); });
$('#backBtn').addEventListener('click', leaveCruise);
$('#modeSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.mode = b.dataset.mode; S.sel = -1; updateTools(); drawRoute(); });
$('#snapBtn').addEventListener('click', () => { S.snap = !S.snap; store.set('cruise_snap', S.snap ? '1' : '0'); updateTools(); toast(S.snap ? 'New segments will follow roads' : 'New segments will be straight lines'); });
$('#undoBtn').addEventListener('click', () => { if (S.points.length) removePoint(S.points.length - 1); });
let clearArm = null;
$('#clearBtn').addEventListener('click', e => {
  const b = e.currentTarget;
  if (clearArm) { clearTimeout(clearArm); clearArm = null; b.textContent = 'Clear'; S.points = []; S.paths = []; S.steps = []; S.sel = -1; changed(); return; }
  b.textContent = 'Sure?'; clearArm = setTimeout(() => { clearArm = null; b.textContent = 'Clear'; }, 3000);
});
$('#zin').addEventListener('click', () => map && map.zoomIn());
$('#zout').addEventListener('click', () => map && map.zoomOut());
$('#locate').addEventListener('click', () => { if (S.me.has) flyTo(S.me.lat, S.me.lng, 16); else toast('Waiting for your location…'); });
$('#fit').addEventListener('click', () => fitAll());
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const sheet = $('#sheet');
  if (b.classList.contains('on') && !sheet.classList.contains('collapsed')) { sheet.classList.add('collapsed'); return; }
  showTab(b.dataset.tab);
});
$('#profileCard').addEventListener('click', openProfile);
$('#pfDone').addEventListener('click', closeProfile);
$('#pfNameIn').addEventListener('input', e => { P.name = e.target.value.slice(0, 20); saveProfile(); });
$('#pfCarIn').addEventListener('input', e => { P.car = e.target.value.slice(0, 40); saveProfile(); });
$('#profileModal').addEventListener('click', e => { if (e.target.id === 'profileModal') closeProfile(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveRecentNow(); });
window.addEventListener('pagehide', saveRecentNow);
$('#startNav').addEventListener('click', startNav);
$('#navEnd').addEventListener('click', () => endNav(false));
$('#navMute').addEventListener('click', () => setVoice(!S.voice));
$('#handle').addEventListener('click', () => $('#sheet').classList.toggle('collapsed'));
$('#searchBtn').addEventListener('click', () => { $('#searchDrawer').classList.contains('open') ? closeSearch() : openSearch(); });
$('#searchClose').addEventListener('click', closeSearch);
$('#searchForm').addEventListener('submit', e => { e.preventDefault(); runSearch($('#searchInput').value); });
$('#photoInput').addEventListener('change', e => { const f = e.target.files; if (f && f.length) uploadPhotos(f); e.target.value = ''; });
$('#cameraInput').addEventListener('change', e => { const f = e.target.files; if (f && f.length) uploadPhotos(f); e.target.value = ''; });
$('#lbClose').addEventListener('click', closeLightbox);
$('#lbPrev').addEventListener('click', () => stepLightbox(-1));
$('#lbNext').addEventListener('click', () => stepLightbox(1));
$('#lbDelete').addEventListener('click', deleteCurrentPhoto);
$('#lbMap').addEventListener('click', () => { const p = S.photos[lbIndex]; if (p && p.lat != null) { closeLightbox(); flyTo(p.lat, p.lng, 16); } });
$('#lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') closeLightbox(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (!$('#lightbox').hidden) closeLightbox(); else closeSearch(); }
  else if (!$('#lightbox').hidden && e.key === 'ArrowLeft') stepLightbox(-1);
  else if (!$('#lightbox').hidden && e.key === 'ArrowRight') stepLightbox(1);
});
document.addEventListener('pointerdown', () => { if (S.active && S.wantAwake && S.wakeState !== 'on') acquireWake(); }, { passive: true });

/* ---------- init ---------- */
S.myId = store.get('cruise_uid');
if (!S.myId) { S.myId = genId(); store.set('cruise_uid', S.myId); }
loadProfile(); renderProfileCard(); renderRecent();
const m = location.search.match(/[?&]c=([a-z0-9]{4,10})/i);
if (m) { $('#joinCode').value = m[1].toUpperCase(); joinCruise(m[1]); }
})();
