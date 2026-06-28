// ============================================================
// build-exotic-calibration.cjs
//   過去の全レースの「本物の着順」を使って、
//   ① ディスカウントHarville の指数(LAM=2着, TAU=3着)を実データで較正し、
//   ② 連系・3連系の予想確率→実測的中率 のビン表(exotic_calibration.json)を作る。
//
//   目的: 画面に出す「ワイド/3連複の的中率」を“本物の数字”にする(楽観バイアス除去)。
//   土台確率 = 市場de-vig(確定オッズ 1/odds をレース内で正規化)= アプリのβ=0と同じ。
//
//   使い方: node scripts/build-exotic-calibration.cjs
// ============================================================
"use strict";
const fs = require("fs");
const path = require("path");
const E = require(path.join(__dirname, "..", "lib", "exotic.js"));

const ROOT = path.resolve(__dirname, "..");
const RESULTS = path.join(ROOT, "data", "jv_cache", "results");
const OUT = path.join(ROOT, "data", "jv_cache", "exotic_calibration.json");

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
const sortKey = (...ns) => ns.slice().sort((a, b) => a - b).join("-");

// 全レースを「市場de-vig勝率 + 実着順」に変換して配列で持つ(指数スイープで何度も使う)
function loadRaces() {
  const files = fs.readdirSync(RESULTS).filter(f => f.endsWith(".json")).sort();
  const races = [];
  for (const f of files) {
    const res = readJson(path.join(RESULTS, f));
    if (!res || !Array.isArray(res.results)) continue;
    const odds = {}; const finishers = [];
    for (const r of res.results) {
      const n = Number(r.number), rank = Number(r.rank), o = Number(r.win_odds);
      if (Number.isFinite(n) && Number.isFinite(o) && o > 1) odds[n] = o;
      if (Number.isFinite(n) && Number.isFinite(rank) && rank >= 1) finishers.push({ n, rank });
    }
    const nums = Object.keys(odds).map(Number);
    if (nums.length < 6) continue;
    let sum = 0; for (const n of nums) sum += 1 / odds[n];
    if (!(sum > 0)) continue;
    const probMap = {};
    for (const n of nums) probMap[n] = (1 / odds[n]) / sum;
    finishers.sort((a, b) => a.rank - b.rank);
    const r1 = finishers[0]?.n, r2 = finishers[1]?.n, r3 = finishers[2]?.n;
    if (r1 == null || r2 == null || r3 == null) continue;
    races.push({ probMap, top3: new Set([r1, r2, r3]), r1, r2 });
  }
  return races;
}

// 指定の指数で、主要戦略の「平均予想 vs 実測」を出す(較正のズレを測る)
function evalDiscount(races, lam, tau) {
  E.setDiscount(lam, tau);
  let n = 0;
  let pw = 0, hw = 0;   // ワイド 本命-対抗
  let pt = 0, ht = 0;   // 3連複 上位3頭BOX
  let pq = 0, hq = 0;   // 馬連 本命-対抗
  for (const R of races) {
    const rk = E.rankByProb(R.probMap);
    const a = rk[0], b = rk[1], c = rk[2];
    if (a == null || b == null || c == null) continue;
    n++;
    pw += E.pWide(R.probMap, a, b);   if (R.top3.has(a) && R.top3.has(b)) hw++;
    pt += E.pTrio(R.probMap, a, b, c); if (R.top3.has(a) && R.top3.has(b) && R.top3.has(c)) ht++;
    pq += E.pQuinella(R.probMap, a, b);
    if ((R.r1 === a && R.r2 === b) || (R.r1 === b && R.r2 === a)) hq++;
  }
  const err = Math.abs(pw / n - hw / n) + Math.abs(pt / n - ht / n) + Math.abs(pq / n - hq / n);
  return { n, wide: [pw / n, hw / n], trio: [pt / n, ht / n], uren: [pq / n, hq / n], err };
}

// 予想確率→実測のビン表を作る(単調・予想を実測へ写像)
function buildBins(samples, edges) {
  // samples: [{p, hit}]; edges: 区切り(昇順) 例 [0.1,0.2,...]
  const bins = [];
  let lo = 0;
  for (const hi of edges) {
    const inB = samples.filter(s => s.p > lo && s.p <= hi);
    if (inB.length >= 30) {
      const rate = inB.reduce((a, s) => a + (s.hit ? 1 : 0), 0) / inB.length;
      bins.push({ pMax: hi, rate, nn: inB.length });
    }
    lo = hi;
  }
  // 最後(上限超え)
  const inB = samples.filter(s => s.p > lo);
  if (inB.length >= 30) {
    const rate = inB.reduce((a, s) => a + (s.hit ? 1 : 0), 0) / inB.length;
    bins.push({ pMax: 1.0, rate, nn: inB.length });
  }
  return bins;
}

function main() {
  const races = loadRaces();
  console.log(`較正対象 ${races.length} レース\n`);

  // ── ① 指数スイープ(LAM 2着, TAU 3着) ──
  const lamGrid = [0.55, 0.62, 0.70, 0.76, 0.85, 0.92, 1.0];
  const tauGrid = [0.45, 0.55, 0.62, 0.70, 0.80, 0.90, 1.0];
  let best = null;
  console.log("=== 指数スイープ(平均予想→実測のズレ最小を探す) ===");
  for (const lam of lamGrid) {
    for (const tau of tauGrid) {
      const r = evalDiscount(races, lam, tau);
      if (!best || r.err < best.err) best = { lam, tau, ...r };
    }
  }
  console.log(`素のHarville(1.0,1.0):`);
  { const r = evalDiscount(races, 1.0, 1.0);
    console.log(`  ワイド 予想${(r.wide[0]*100).toFixed(1)}% 実${(r.wide[1]*100).toFixed(1)}% / 3連複 予想${(r.trio[0]*100).toFixed(1)}% 実${(r.trio[1]*100).toFixed(1)}% / 馬連 予想${(r.uren[0]*100).toFixed(1)}% 実${(r.uren[1]*100).toFixed(1)}% / ズレ計${(r.err*100).toFixed(1)}pt`); }
  console.log(`★最良 LAM=${best.lam} TAU=${best.tau}:`);
  console.log(`  ワイド 予想${(best.wide[0]*100).toFixed(1)}% 実${(best.wide[1]*100).toFixed(1)}% / 3連複 予想${(best.trio[0]*100).toFixed(1)}% 実${(best.trio[1]*100).toFixed(1)}% / 馬連 予想${(best.uren[0]*100).toFixed(1)}% 実${(best.uren[1]*100).toFixed(1)}% / ズレ計${(best.err*100).toFixed(1)}pt\n`);

  // ── ② 最良指数でビン表を作る ──
  E.setDiscount(best.lam, best.tau);
  const wideS = [], trioS = [], placeS = [];
  for (const R of races) {
    const rk = E.rankByProb(R.probMap);
    const a = rk[0], b = rk[1], c = rk[2];
    if (a == null || b == null || c == null) continue;
    wideS.push({ p: E.pWide(R.probMap, a, b), hit: R.top3.has(a) && R.top3.has(b) });
    trioS.push({ p: E.pTrio(R.probMap, a, b, c), hit: R.top3.has(a) && R.top3.has(b) && R.top3.has(c) });
    // 本命の複勝(3着内)も Harville 由来で較正(参考・既存 place_calibration と別系統)
    placeS.push({ p: E.pTop3(R.probMap, a), hit: R.top3.has(a) });
  }
  const wideBins = buildBins(wideS, [0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
  const trioBins = buildBins(trioS, [0.05, 0.08, 0.12, 0.18, 0.25, 0.35]);

  const out = {
    generatedAt: new Date().toISOString(),
    races: races.length,
    discount: { lam: best.lam, tau: best.tau },
    note: "ディスカウントHarville。wide=本命-対抗ワイド, trio=上位3頭BOX 3連複。p(予想確率)→rate(実測的中率)。",
    wide: wideBins,
    trio: trioBins,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log("=== ワイド較正表(予想→実測) ===");
  for (const b of wideBins) console.log(`  ~${(b.pMax*100).toFixed(0)}%: 実${(b.rate*100).toFixed(1)}% (${b.nn}件)`);
  console.log("=== 3連複較正表(予想→実測) ===");
  for (const b of trioBins) console.log(`  ~${(b.pMax*100).toFixed(0)}%: 実${(b.rate*100).toFixed(1)}% (${b.nn}件)`);
  console.log(`\n保存: ${OUT}`);
}

main();
