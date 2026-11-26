// Bygger Modell D-sidan: hämtar data, räknar signal, dagsprognos och exitkort, skriver till dist/.
// Körs av GitHub Actions varje kväll. Inga hemligheter behövs (FRED_API_KEY valfri).
import fs from 'fs';
import path from 'path';
import { buildModel, add, months, ASSETS, NAMES } from '../lib/model.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'dist');
const MON = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const MODEL_BUILT = '2026-11'; // händelser före detta är beräknade i efterhand

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (modell-d; github actions)' } });
      if (r.ok) return await r.text();
      if (r.status < 500) throw new Error(`${url}: ${r.status}`);
    } catch (e) { if (i === 2) throw e; }
    await new Promise((res) => setTimeout(res, 3000 * (i + 1)));
  }
}
// FRED: månadsserier nycklas YYYY-MM, dagsserier YYYY-MM-DD
async function fred(id, daily = false) {
  const out = {}, key = process.env.FRED_API_KEY;
  if (key) {
    const j = JSON.parse(await get(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json`));
    for (const o of j.observations) if (o.value !== '.') out[daily ? o.date : o.date.slice(0, 7)] = +o.value;
  } else {
    for (const line of (await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`)).trim().split('\n').slice(1)) {
      const [d, v] = line.split(','); if (v && v !== '.' && !isNaN(+v)) out[daily ? d : d.slice(0, 7)] = +v;
    }
  }
  if (Object.keys(out).length < 50) throw new Error(`FRED ${id}: för lite data`);
  return out;
}
// CAPE: multpl månadstabell; faller tillbaka på senast sparade (data/cape.json) om sidan inte går att läsa
async function cape() {
  const store = path.join(ROOT, 'data', 'cape.json');
  let saved = {}; try { saved = JSON.parse(fs.readFileSync(store)); } catch {}
  try {
    const html = await get('https://www.multpl.com/shiller-pe/table/by-month'); const out = {};
    const re = /<td[^>]*>\s*([A-Z][a-z]{2}) \d{1,2}, (\d{4})\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g; let x;
    while ((x = re.exec(html))) {
      const n = x[3].replace(/<[^>]+>|&#x?[0-9a-f]+;|&[a-z]+;/gi, ' ').match(/-?\d+(\.\d+)?/);
      if (n && MON[x[1]]) { const k = `${x[2]}-${MON[x[1]]}`; if (!(k in out)) out[k] = +n[0]; }
    }
    if (Object.keys(out).length < 400) throw new Error('kunde inte läsa tabellen');
    fs.mkdirSync(path.dirname(store), { recursive: true }); fs.writeFileSync(store, JSON.stringify(out));
    return { CAPE: out, capeSource: 'multpl.com' };
  } catch (e) {
    if (Object.keys(saved).length < 400) throw new Error('CAPE: ' + e.message);
    return { CAPE: saved, capeSource: `sparad kopia (multpl gick inte att läsa: ${e.message})` };
  }
}

process.on("unhandledRejection", (e) => { console.error("FEL:", e?.message || e); process.exit(1); });
async function gold() {
  try {
    const out = {};
    for (const line of (await get('https://eco3min.fr/dataset/gold-price.csv')).split(/\r?\n/)) {
      const m = line.match(/^\s*"?(\d{4})-(\d{2})(?:-\d{2})?"?\s*[,;]\s*"?([\d.]+)/);
      if (m) out[`${m[1]}-${m[2]}`] = +m[3];
    }
    if (Object.keys(out).length < 100) throw new Error('för lite data');
    return out;
  } catch (e) { console.error('Guld:', e.message); return {}; }
}
const goldP = gold();
const [LR, TB, SP, CPI, BAA10Y, DGS10, DTB3, SPX, capeR] = await Promise.all([
  fred('GS10'), fred('TB3MS'), fred('BAA10YM'), fred('CPIAUCNS'),
  fred('BAA10Y', true), fred('DGS10', true), fred('DTB3', true), fred('SP500', true), cape(),
]);
const { CAPE, capeSource } = capeR;

// datamånad k = senaste månad där alla månadsserier finns
const k = Object.keys(LR).filter((m) => m in TB && m in SP && m in CAPE).sort().pop();
const cpiLatest = Object.keys(CPI).sort().pop();
// KPI-luckor mitt i serien (t.ex. okt 2025, som BLS aldrig publicerade) interpoleras geometriskt mellan grannmånaderna
{ const ks = Object.keys(CPI).sort();
  for (let i = 1; i < ks.length; i++) { const a = ks[i - 1], b = ks[i], gap = months(a, b).slice(1, -1);
    gap.forEach((m, j) => { CPI[m] = CPI[a] * Math.pow(CPI[b] / CPI[a], (j + 1) / (gap.length + 1)); }); } }
for (const s of [CPI, TB]) { let lv = null; for (const m of months('1930-01', add(k, 2))) { if (m in s) lv = s[m]; else if (lv != null) s[m] = lv; } }

const M = buildModel({ CAPE, LR, TB, SP, CPI });
const now = M.signal(add(k, 1));
const history = months(add(k, -22), add(k, 1)).map((m) => { const s = M.signal(m); return { month: m, w: s.w, lev: s.lev, phase: s.phase }; });

// dagsprognos: innevarande månad hittills
const c = add(k, 1), inC = (o) => Object.keys(o).filter((d) => d.startsWith(c)).sort();
const avg = (o) => { const ks = inC(o); return ks.length ? ks.reduce((a, d) => a + o[d], 0) / ks.length : null; };
let nowcast = null;
const sp = avg(BAA10Y), lr = avg(DGS10), tb = avg(DTB3);
// CAPE för innevarande månad: multpl:s löpande värde, annars senast kända (framfört)
let capeNote = '';
if (!(c in CAPE)) { const lastK = Object.keys(CAPE).sort().pop(); CAPE[c] = CAPE[lastK]; capeNote = ` (CAPE för ${c} saknas; ${lastK} används)`; }
if (sp != null && lr != null && tb != null) {
  const S2 = { CPI, CAPE, LR: { ...LR, [c]: lr }, TB: { ...TB, [c]: tb }, SP: { ...SP, [c]: sp } };
  const pre = buildModel(S2).signal(add(c, 1)); const lastDay = inC(BAA10Y).pop();
  nowcast = { month: c, decisionFor: pre.month, tradingDays: inC(BAA10Y).length, lastDay,
    today: { spread: BAA10Y[lastDay], GS10: DGS10[inC(DGS10).pop()], CAPE: CAPE[c] }, monthAvg: { spread: sp, GS10: lr, TB3: tb }, signal: pre,
    changes: JSON.stringify(Object.entries(pre.w).sort()) !== JSON.stringify(Object.entries(now.w).sort()) || pre.lev !== now.lev };
}
// --- Uppföljning: låsta beslut och verkliga månadsresultat från start (nov 2026) ---
const START = '2026-11';
const decF = path.join(ROOT, 'data', 'decisions.json');
let decisions = {}; try { decisions = JSON.parse(fs.readFileSync(decF)); } catch {}
if (now.month >= START && !decisions[now.month]) decisions[now.month] = { w: now.w, lev: now.lev, phase: now.phase, decidedOn: new Date().toISOString().slice(0, 10), dataMonth: k };
fs.mkdirSync(path.dirname(decF), { recursive: true }); fs.writeFileSync(decF, JSON.stringify(decisions, null, 2));
const GOLD = await goldP;
const par = (y0, y1, n) => { const c = y0 / 200, y = y1 / 200; return c / y * (1 - (1 + y) ** -(2 * n)) + (1 + y) ** -(2 * n) - 1 + y0 / 1200; };
const spxDays = Object.keys(SPX).sort();
const monthEnd = (m) => { const d = spxDays.filter((x) => x.startsWith(m)).pop(); return d ? SPX[d] : null; };
const todayStr = new Date().toISOString().slice(0, 10);
const assetRet = (a, m) => { const p = add(m, -1);
  if (a === 'CASH') return TB[p] != null ? TB[p] / 1200 : null;
  if (a === 'BOND') return LR[p] != null && LR[m] != null ? par(LR[p], LR[m], 10) : null;
  if (a === 'CREDIT') return [LR[p], LR[m], SP[p], SP[m]].every((x) => x != null) ? par(LR[p] + SP[p], LR[m] + SP[m], 20) - 0.005 / 12 : null;
  if (a === 'GOLD') return GOLD[p] && GOLD[m] ? GOLD[m] / GOLD[p] - 1 : null;
  if (a === 'EQ') { const e0 = monthEnd(p), e1 = monthEnd(m); return e0 && e1 && `${add(m, 1)}-01` <= todayStr ? e1 / e0 - 1 : null; } };
const results = []; let prevW = {}; const cum = { D: 1, SPX: 1, '60/40': 1 };
for (const m of Object.keys(decisions).sort()) {
  const d = decisions[m]; if (`${add(m, 1)}-01` > todayStr) break; // månaden är inte slut
  const need = [...new Set([...Object.keys(d.w), 'EQ', 'BOND', 'CASH'])], r = {};
  for (const a of need) r[a] = assetRet(a, m);
  const missing = need.filter((a) => r[a] == null);
  if (missing.length) { results.push({ month: m, pending: missing }); break; }
  const to = ASSETS.reduce((t, a) => t + Math.abs((d.w[a] || 0) - (prevW[a] || 0)), 0) / 2;
  const rD = d.lev * Object.entries(d.w).reduce((t, [a, w]) => t + w * r[a], 0) - (d.lev - 1) * (TB[add(m, -1)] / 1200 + 0.01 / 12) - 0.001 * to * d.lev;
  const row = { month: m, w: d.w, lev: d.lev, D: rD, SPX: r.EQ, '60/40': 0.6 * r.EQ + 0.4 * r.BOND, assets: r };
  for (const kk of Object.keys(cum)) { cum[kk] *= 1 + row[kk]; row['cum_' + kk] = cum[kk] - 1; }
  results.push(row); prevW = d.w;
}
fs.writeFileSync(path.join(ROOT, 'data', 'results.csv'), 'månad,innehav,hävstång,D,S&P 500 (pris),60/40,D ackumulerat,S&P ackumulerat,60/40 ackumulerat\n' +
  results.filter((x) => !x.pending).map((x) => [x.month, Object.entries(x.w).map(([a, w]) => `${a} ${Math.round(w * 100)}%`).join(' + '), x.lev, x.D, x.SPX, x['60/40'], x.cum_D, x.cum_SPX, x['cum_60/40']].map((v) => typeof v === 'number' ? +v.toFixed(5) : v).join(',')).join('\n') + '\n');

const goldInfo = Object.keys(GOLD).length ? `Guld (Världsbanken): ${Object.keys(GOLD).length} månader, senast ${Object.keys(GOLD).sort().pop()}.` : 'Guld: prisserien kunde inte hämtas.';
const signal = { goldInfo, results, resultsStart: START, generated: new Date().toISOString(), decisionFor: now.month, dataMonth: k, names: NAMES, assets: ASSETS, now, history, nowcast,
  notes: ['Beslutet gäller hela nästa månad. Byt innehav första handelsdagen.', 'Hävstång 1,5× innebär lån till ungefär kortränta + 1 procentenhet.',
    `Dagsdata från FRED (BAA10Y, DGS10, DTB3); ${nowcast?.tradingDays ?? 0} handelsdagar i månaden hittills. CAPE: ${capeSource}${capeNote}.`,
    cpiLatest < k ? `KPI för ${k} är inte publicerad än; ${cpiLatest} används.` : 'KPI är uppdaterad.'] };

// exitkort: S&P 500 mot ATH och D:s in/ut-byten i aktier (FRED har 10 års dagsdata)
const days = Object.keys(SPX).sort();
const athUpTo = (d) => { let a = null; for (const x of days) { if (x > d) break; if (!a || SPX[x] > a.level) a = { date: x, level: SPX[x] }; } return a; };
const events = []; let prevIn = null;
for (const m of months(add(days[0].slice(0, 7), 1), add(k, 1))) {
  const isIn = 'EQ' in M.signal(m).w;
  if (prevIn !== null && isIn !== prevIn) {
    const pd = days.filter((x) => x < `${m}-01`).pop();
    if (pd) events.push({ type: isIn ? 'entry' : 'exit', month: m, date: pd, level: SPX[pd], athThen: athUpTo(pd),
      ...(m <= MODEL_BUILT ? { note: 'Beräknat i efterhand: Modell D byggdes 24 nov. 2026, så inga faktiska affärer ligger bakom.' } : {}) });
  }
  prevIn = isIn;
}
const lastD = days[days.length - 1];
const spx = { source: 'FRED SP500 (officiella dagliga stängningar)', updated: new Date().toISOString().slice(0, 10),
  ath: athUpTo(lastD), last: { date: lastD, level: SPX[lastD] }, events: events.slice(-1) };

// skriv ut sidan
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'lib'), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'site'))) fs.cpSync(path.join(ROOT, 'site', f), path.join(OUT, f), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'lib', 'backtest.json'), path.join(OUT, 'lib', 'backtest.json'));
fs.writeFileSync(path.join(OUT, 'signal.json'), JSON.stringify(signal));
fs.writeFileSync(path.join(OUT, 'spx.json'), JSON.stringify(spx, null, 2));
// daglig logg i repot (historik över varje dags beslut och prognos)
const logF = path.join(ROOT, 'data', 'log.csv');
if (!fs.existsSync(logF)) fs.writeFileSync(logF, 'datum,datamånad,beslut_för,beslut,hävstång,prognos_för,prognos,prognos_hävstång,baa10y,sp500\n');
const fmt = (w) => Object.entries(w).map(([a, v]) => `${a} ${Math.round(v * 100)}%`).join(' + ');
const today = signal.generated.slice(0, 10);
fs.writeFileSync(logF, fs.readFileSync(logF, 'utf8').split('\n').filter((l) => l && !l.startsWith(today)).join('\n') + '\n'); // en rad per dag
fs.appendFileSync(logF, [signal.generated.slice(0, 10), k, now.month, fmt(now.w), now.lev, nowcast?.decisionFor ?? '', nowcast ? fmt(nowcast.signal.w) : '', nowcast?.signal.lev ?? '', nowcast?.today.spread ?? '', SPX[lastD]].join(',') + '\n');
console.log(`Data ${k} | beslut ${now.month}: ${fmt(now.w)} ×${now.lev} | prognos ${nowcast?.decisionFor}: ${nowcast ? fmt(nowcast.signal.w) + ' ×' + nowcast.signal.lev : '-'} | S&P ${SPX[lastD]} (${lastD}) | CAPE ${capeSource}`);
