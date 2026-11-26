// Modell D: dynamisk allokering mellan aktier, stat, kredit, guld och kassa.
// Exakt samma regler som dyn.py / PREREG_dyn.md + tillägg 1 (variant D).
// Indata: månadsserier som objekt { 'YYYY-MM': värde }.
//   CAPE (Shiller P/E), LR (GS10), TB (TB3MS), SP (BAA10YM = Baa − 10y), CPI (CPIAUCNS)

export const ASSETS = ['EQ', 'BOND', 'CREDIT', 'GOLD', 'CASH'];
export const NAMES = { EQ: 'Aktier (S&P 500)', BOND: 'Statsobligationer 10 år', CREDIT: 'Företagsobligationer (Baa)', GOLD: 'Guld', CASH: 'Kassa (T-bill)' };

const fx = (x, d = 1) => x.toFixed(d).replace('.', ',').replace('-', '−');
const sg = (x, d = 1) => (x >= 0 ? '+' : '') + fx(x, d);

export function add(m, k) {
  const [y, mm] = m.split('-').map(Number); const t = y * 12 + mm - 1 + k;
  return `${String(Math.floor(t / 12)).padStart(4, '0')}-${String((t % 12) + 1).padStart(2, '0')}`;
}
export function months(a, b) { const out = []; for (let m = a; m <= b; m = add(m, 1)) out.push(m); return out; }

export function buildModel(S) {
  const { CAPE, LR, TB, SP } = S;
  const CPI = S.CPI;
  const infl = (m) => { const p = add(m, -12); return (m in CPI && p in CPI) ? (CPI[m] / CPI[p] - 1) * 100 : null; };
  const rpct = (series, m, yrs = 30) => {
    const ks = months(add(m, -12 * yrs), m).filter((k) => k in series);
    if (ks.length < 60) return null; const v = series[m];
    return 100 * ks.filter((k) => series[k] <= v).length / ks.length;
  };
  const min = (a) => Math.min(...a), max = (a) => Math.max(...a);
  function stackParts(m) {
    const i24 = months(add(m, -24), m).map(infl);
    const parts = {
      cape: { on: (rpct(CAPE, m) ?? 0) >= 80, txt: `CAPE ${fx(CAPE[m], 1)} på percentil ${fx(rpct(CAPE, m) ?? 0, 0)} av 30 år (gräns 80)` },
      infl: { on: infl(m) - min(i24) >= 1.5, txt: `Inflation ${fx(infl(m), 1)} %, ${sg(infl(m) - min(i24), 1)} pp mot 24-mån-min (gräns 1,5)` },
      tb: { on: TB[m] - min(months(add(m, -36), m).map((k) => TB[k])) >= 0.75, txt: `T-bill ${fx(TB[m], 2)} %, ${sg(TB[m] - min(months(add(m, -36), m).map((k) => TB[k])), 2)} pp mot 36-mån-min (gräns 0,75)` },
      lr: { on: LR[m] - LR[add(m, -24)] >= 0.75, txt: `10-årsränta ${fx(LR[m], 2)} %, ${(LR[m] - LR[add(m, -24)] >= 0 ? '+' : '')}${fx(LR[m] - LR[add(m, -24)], 2)} pp på 24 mån (gräns 0,75)` },
      inv: { on: min(months(add(m, -24), m).map((k) => LR[k] - TB[k])) < 0, txt: `Inverterad kurva senaste 24 mån: ${min(months(add(m, -24), m).map((k) => LR[k] - TB[k])) < 0 ? 'ja' : 'nej'}` },
    };
    return parts;
  }
  const stack = (m) => Object.values(stackParts(m)).filter((p) => p.on).length;
  const crack = (m) => { const ks = months(add(m, -24), m).filter((k) => k in SP); return SP[m] - min(ks.map((k) => SP[k])) >= 0.4; };
  const cut = (m) => TB[m] <= max(months(add(m, -12), m).map((k) => TB[k])) - 1.0;

  // stegmodellens fasmaskin från 1955
  const phase = {}, peak = {}; let state = 'N', PE = null;
  const last = Object.keys(LR).filter((k) => k in TB && k in SP && k in CAPE).sort().pop();
  for (const m of months('1955-01', last)) {
    const s = stack(m); let ph;
    if (state === 'N') {
      ph = s >= 3 ? 'Förvarning' : 'Expansion';
      if (s >= 3 && crack(m)) { state = 'D'; PE = SP[m]; ph = 'Spricka'; }
    } else {
      PE = Math.max(PE, SP[m]);
      if (PE - SP[m] >= 0.5) { state = 'N'; ph = 'Läkning bekräftad'; }
      else if (PE - SP[m] >= 0.2 && cut(m)) ph = 'Läkning börjar';
      else ph = 'Spricka';
    }
    phase[m] = ph; peak[m] = state === 'D' ? PE : null;
  }

  const pi = (k) => infl(add(k, -1));
  function signal(m) {
    const k = add(m, -1); const p = pi(k);
    const er = { EQ: 100 / CAPE[k], BOND: LR[k] - p, CREDIT: LR[k] + SP[k] - 0.5 - p, GOLD: 0, CASH: TB[k] - p };
    const i24 = months(add(k, -24), k).map(pi);
    const bondF = p - min(i24) >= 1.5 && LR[k] - p < 1.0;
    const rrK = months(add(k, -24), k).map((x) => TB[x] - pi(x)); const rr = TB[k] - p;
    const flag = { EQ: phase[k] === 'Spricka', BOND: bondF, CREDIT: crack(k) || bondF, GOLD: rr > 0 && rr - min(rrK) >= 2.0, CASH: false };
    const why = {
      EQ: `Stegfas: ${phase[k]}` + (peak[k] != null ? ` · sprickan läker när Baa−10y faller till ${fx(peak[k] - 0.5, 2)} (toppen ${fx(peak[k], 2)} minus 0,5)` : ''),
      BOND: `Inflation ${sg(p - min(i24), 1)} pp mot 24-mån-min (gräns 1,5), realränta ${fx(LR[k] - p, 1)} % (gräns < 1)`,
      CREDIT: `Baa−10y ${fx(SP[k], 2)} pp, ${sg(SP[k] - min(months(add(k, -24), k).filter((x) => x in SP).map((x) => SP[x])), 2)} mot 24-mån-min (spricka vid 0,4)${bondF ? '; statsflaggan aktiv' : ''}`,
      GOLD: `Real T-bill ${fx(rr, 1)} %, ${sg(rr - min(rrK), 1)} pp mot 24-mån-min (flagga om > 0 och ≥ 2)`,
      CASH: 'Flaggas aldrig',
    };
    const ok = ASSETS.filter((a) => !flag[a]).sort((a, b) => er[b] - er[a]);
    let w = ok.length > 1 ? { [ok[0]]: 0.5, [ok[1]]: 0.5 } : { [ok[0]]: 1 };
    const lev = 'CASH' in w ? 1 : 1.5;
    const crackAt = min(months(add(k, -24), k).filter((x) => x in SP).map((x) => SP[x])) + 0.4;
    return { month: m, dataMonth: k, er, flag, why, rank: ok, w, lev, phase: phase[k], stack: stackParts(k), inflUsed: p, healAt: peak[k] != null ? peak[k] - 0.5 : null, crackAt };
  }
  return { signal, phase, last };
}
