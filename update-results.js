// Actualiza results/ en Firebase con los marcadores finales de football-data.org
// Variables: FOOTBALL_DATA_KEY (obligatoria), FIREBASE_DB_SECRET (opcional)
//            DRY_RUN=1 (no escribe), MOCK_API_FILE=ruta.json (prueba sin red)
const fs = require('fs');
const path = require('path');

const DB_URL = 'https://champions-league-predicion-default-rtdb.firebaseio.com';
const API_KEY = process.env.FOOTBALL_DATA_KEY;
const DRY = process.env.DRY_RUN === '1';

// ---- 1. Leer el fixture desde index.html (misma fuente que la app: ids m1, m2, ...) ----
//const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const htmlPath = path.join(__dirname, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const block = html.match(/const RAW_MATCHES = \[([\s\S]*?)\n\];/)[1];
const rowRe = /\[(\d+),"([\d-]+)","([\d:]+)","([^"]+)","([^"]+)",(null|\d+),(null|\d+)\]/g;
const MATCHES = [];
let r, i = 0;
while ((r = rowRe.exec(block))) {
  i++;
  MATCHES.push({ id: 'm' + i, date: r[2], time: r[3], home: r[4], away: r[5], done: r[6] !== 'null' });
}

// ---- 2. Horario CET/CEST -> instante UTC (igual que la app) ----
function lastSundayUTC(y, m) { const d = new Date(Date.UTC(y, m + 1, 0, 1)); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d.getTime(); }
function eo(u) { const y = new Date(u).getUTCFullYear(); return (u >= lastSundayUTC(y, 2) && u < lastSundayUTC(y, 9)) ? 2 : 1; }
function kickoff(m) {
  const [Y, M, D] = m.date.split('-').map(Number), [h, mi] = m.time.split(':').map(Number);
  const n = Date.UTC(Y, M - 1, D, h, mi); let o = eo(n - 7200000); o = eo(n - o * 3600000);
  return n - o * 3600000;
}

// ---- 3. Emparejar nombres de equipos (la API dice "FC Barcelona", la app "Barcelona") ----
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const KEY = { // nombre en la app -> palabra clave que debe contener el nombre de la API
  'Atlético de Madrid': 'atletico', 'Inter': 'inter', 'Sporting CP': 'sporting', 'Paris Saint-Germain': 'paris saint',
  'Bayern München': 'bayern', 'PSV Eindhoven': 'psv', 'Roma': 'roma', 'Bodø/Glimt': 'glimt', 'Club Brugge': 'brugge',
  'Slavia Praha': 'slavia', 'Slovan Bratislava': 'slovan', 'Shakhtar Donetsk': 'shakhtar', 'AEK Athens': 'aek',
  'Borussia Dortmund': 'dortmund', 'Leipzig': 'leipzig', 'Aston Villa': 'aston villa', 'Manchester City': 'manchester city',
  'Manchester United': 'manchester united', 'Real Betis': 'betis', 'Real Madrid': 'real madrid', 'Fenerbahçe': 'fenerbahce',
};
const sameTeam = (appName, apiTeam) => {
  const k = KEY[appName] || norm(appName);
  return [apiTeam.name, apiTeam.shortName, apiTeam.tla].filter(Boolean).some(n => norm(n).includes(k) || (k.length > 3 && k.includes(norm(n)) && norm(n).length > 3));
};

(async () => {
  // ---- 4. Pedir partidos terminados de los últimos días ----
  const day = 86400000, now = Date.now();
  const f = t => new Date(t).toISOString().slice(0, 10);
  let data;
  if (process.env.MOCK_API_FILE) {
    data = JSON.parse(fs.readFileSync(process.env.MOCK_API_FILE, 'utf8'));
  } else {
    if (!API_KEY) throw new Error('Falta FOOTBALL_DATA_KEY');
    const url = `https://api.football-data.org/v4/competitions/CL/matches?dateFrom=${f(now - 3 * day)}&dateTo=${f(now + day)}`;
    const res = await fetch(url, { headers: { 'X-Auth-Token': API_KEY } });
    if (!res.ok) throw new Error(`football-data.org respondió ${res.status}: ${await res.text()}`);
    data = await res.json();
  }

  const updates = {}, unmatched = [];
  for (const ap of data.matches || []) {
    if (ap.status !== 'FINISHED') continue;
    const ft = ap.score && ap.score.fullTime;
    if (!ft || ft.home == null || ft.away == null) continue;
    const t = Date.parse(ap.utcDate);
    const m = MATCHES.find(x => !x.done && Math.abs(kickoff(x) - t) < 12 * 3600000 &&
      sameTeam(x.home, ap.homeTeam) && sameTeam(x.away, ap.awayTeam));
    if (m) updates[m.id] = { h: ft.home, a: ft.away, _label: `${m.home} ${ft.home}-${ft.away} ${m.away}` };
    else unmatched.push(`${ap.homeTeam.name} ${ft.home}-${ft.away} ${ap.awayTeam.name} (${ap.utcDate})`);
  }

  const payload = {};
  for (const [id, v] of Object.entries(updates)) { payload[id] = { h: v.h, a: v.a }; console.log('OK  ', id, v._label); }
  unmatched.forEach(u => console.warn('SIN EMPAREJAR:', u));
  if (!Object.keys(payload).length) { console.log('Nada nuevo que escribir.'); return; }
  if (DRY) { console.log('DRY_RUN: no se escribe en Firebase.', JSON.stringify(payload)); return; }

  // ---- 5. Escribir en Firebase (PATCH = mezcla, no borra otros resultados) ----
  const auth = process.env.FIREBASE_DB_SECRET ? `?auth=${process.env.FIREBASE_DB_SECRET}` : '';
  const w = await fetch(`${DB_URL}/results.json${auth}`, { method: 'PATCH', body: JSON.stringify(payload) });
  if (!w.ok) throw new Error(`Firebase respondió ${w.status}: ${await w.text()}`);
  console.log('Firebase actualizado.');
})().catch(e => { console.error(e.message); process.exit(1); });
