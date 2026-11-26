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
const [LR, TB, SP, CPI, BAA10Y, DGS10, DTB3, SPX, capeR] = await Promise.all([
  fred('GS10'), fred('TB3MS'), fred('BAA10YM'), fred('CPIAUCNS'),
  fred('BAA10Y', true), fred('DGS10', true), fred('DTB3', true), fred('SP500', true), cape(),
]);
const { CAPE, capeSource } = capeR;

// datamånad k = senaste månad där alla månadsserier finns
const k = Object.keys(LR).filter((m) => m in TB && m in SP && m in CAPE).sort().pop();
const cpiLatest = Object.keys(CPI).sort().pop();
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
const signal = { generated: new Date().toISOString(), decisionFor: now.month, dataMonth: k, names: NAMES, assets: ASSETS, now, history, nowcast,
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
fs.appendFileSync(logF, [signal.generated.slice(0, 10), k, now.month, fmt(now.w), now.lev, nowcast?.decisionFor ?? '', nowcast ? fmt(nowcast.signal.w) : '', nowcast?.signal.lev ?? '', nowcast?.today.spread ?? '', SPX[lastD]].join(',') + '\n');
console.log(`Data ${k} | beslut ${now.month}: ${fmt(now.w)} ×${now.lev} | prognos ${nowcast?.decisionFor}: ${nowcast ? fmt(nowcast.signal.w) + ' ×' + nowcast.signal.lev : '-'} | S&P ${SPX[lastD]} (${lastD}) | CAPE ${capeSource}`);
