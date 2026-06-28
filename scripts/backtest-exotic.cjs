// ============================================================
// 「勝てる馬券」を本気で探すバックテスト。
//   過去の全レースで、Harville確率から作った各買い方(単勝〜3連単・box・formation)を
//   実際に買っていたら回収率(ROI)が何%だったかを、本物の払戻で計算する。
//   ★控除(20〜30%)を本当に超える買い方が1つでもあるかを正直に探す。
//
// 確率の土台 = 市場de-vig(確定オッズ 1/odds をレース内で正規化)。
//   Benter の手法どおり「超優秀な単勝プール」を土台に exotic を攻める。
//   (--cal で実測較正・--model で当アプリのモデル確率に切替も可)
//
// 使い方: node scripts/backtest-exotic.cjs            (全期間・市場de-vig)
//        node scripts/backtest-exotic.cjs --last 1500
//        node scripts/backtest-exotic.cjs --cal       (較正勝率を土台に)
// ============================================================
"use strict";
const fs = require("fs");
const path = require("path");
const E = require(path.join(__dirname, "..", "lib", "exotic.js"));

const ROOT = path.resolve(__dirname, "..");
const RESULTS = path.join(ROOT, "data", "jv_cache", "results");
const CALIB = path.join(ROOT, "data", "jv_cache", "place_calibration.json");

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

// 市場de-vig勝率を「実際に勝った率」へ写像する較正(任意)
let CAL = null;
function loadCal() { if (CAL === null) { const c = readJson(CALIB); CAL = (c && Array.isArray(c.bins)) ? c.bins : []; } return CAL; }
function calWin(p, bins) { if (!bins.length) return p; if (p <= bins[0].pMax) return bins[0].win; for (const b of bins) if (p <= b.pMax) return b.win; return bins[bins.length - 1].win; }

const args = process.argv.slice(2);
const lastIdx = args.indexOf("--last");
const lastN = lastIdx >= 0 ? Number(args[lastIdx + 1]) : null;
const useCal = args.includes("--cal");

// 払戻キー正規化(順不同は昇順、順序ありはそのまま)
const sortKey = (...ns) => ns.slice().sort((a, b) => a - b).join("-");

// 各戦略の集計箱
function mkStrat(label) { return { label, bets: 0, cost: 0, ret: 0, hits: 0 }; }
function tally(s, costPts, won, payoutAmt) {
  s.bets++; s.cost += costPts * 100; if (won) { s.hits++; s.ret += payoutAmt; }
}

function main() {
  let files = fs.readdirSync(RESULTS).filter(f => f.endsWith(".json")).sort();
  if (Number.isFinite(lastN) && lastN > 0) files = files.slice(-lastN);
  const bins = useCal ? loadCal() : null;

  const S = {
    tan1:        mkStrat("単勝 本命"),
    fuku1:       mkStrat("複勝 本命"),
    wide12:      mkStrat("ワイド 本命-対抗"),
    wideBox3:    mkStrat("ワイド 上位3頭BOX(3点)"),
    umaren12:    mkStrat("馬連 本命-対抗"),
    trio3:       mkStrat("3連複 上位3頭BOX(1点)"),
    trio4:       mkStrat("3連複 上位4頭BOX(4点)"),
    trio5:       mkStrat("3連複 上位5頭BOX(10点)"),
    trioF1:      mkStrat("3連複 軸1頭(本命)-相手4頭(6点)"),
    tan3_123:    mkStrat("3連単 本命→対抗→単穴(1点)"),
    tan3_F:      mkStrat("3連単 1着本命-2,3着 上位2-4(6点)"),
  };

  let used = 0, skipped = 0;
  for (const f of files) {
    const res = readJson(path.join(RESULTS, f));
    if (!res || !Array.isArray(res.results) || !res.payouts) { skipped++; continue; }
    const P = res.payouts;

    // 確定オッズ→市場de-vig勝率
    const odds = {}; const finishers = [];
    for (const r of res.results) {
      const n = Number(r.number), rank = Number(r.rank), o = Number(r.win_odds);
      if (Number.isFinite(n) && Number.isFinite(o) && o > 1) odds[n] = o;
      if (Number.isFinite(n) && Number.isFinite(rank) && rank >= 1) finishers.push({ n, rank });
    }
    const nums = Object.keys(odds).map(Number);
    if (nums.length < 6) { skipped++; continue; } // 少頭数は exotic 不成立が多い→除外
    let sum = 0; for (const n of nums) sum += 1 / odds[n];
    if (!(sum > 0)) { skipped++; continue; }
    const probMap = {};
    for (const n of nums) probMap[n] = (1 / odds[n]) / sum;
    if (bins) { // 較正を掛けて再正規化
      let cs = 0; const tmp = {};
      for (const n of nums) { tmp[n] = calWin(probMap[n], bins); cs += tmp[n]; }
      if (cs > 0) for (const n of nums) probMap[n] = tmp[n] / cs;
    }

    // 実際の着順
    finishers.sort((a, b) => a.rank - b.rank);
    const r1 = finishers[0]?.n, r2 = finishers[1]?.n, r3 = finishers[2]?.n;
    if (r1 == null || r2 == null || r3 == null) { skipped++; continue; }
    const top3Set = new Set([r1, r2, r3]);

    // 予想の並び(勝率降順)
    const rk = E.rankByProb(probMap);
    const a = rk[0], b = rk[1], c = rk[2], d = rk[3], e = rk[4];
    used++;

    // ── 払戻ヘルパ ──
    const tanAmt = (P.tan && P.tan.winner === r1) ? P.tan.amount : 0;
    const fukuAmt = (num) => { const x = (P.fuku || []).find(z => z.number === num); return x ? x.amount : 0; };
    const wideAmt = (x, y) => { const k = sortKey(x, y); const w = (P.wide || []).find(z => z.key === k); return w ? w.amount : 0; };
    const urenAmt = (x, y) => (P.uren && P.uren.key === sortKey(x, y)) ? P.uren.amount : 0;
    const trioAmt = (x, y, z) => (P.fuku3 && P.fuku3.key === sortKey(x, y, z)) ? P.fuku3.amount : 0;
    const tan3Amt = (x, y, z) => (P.tan3 && P.tan3.key === `${x}-${y}-${z}`) ? P.tan3.amount : 0;

    // ── 各戦略 ──
    // 単勝 本命
    tally(S.tan1, 1, a === r1, tanAmt);
    // 複勝 本命
    tally(S.fuku1, 1, top3Set.has(a), fukuAmt(a));
    // ワイド 本命-対抗
    tally(S.wide12, 1, top3Set.has(a) && top3Set.has(b), wideAmt(a, b));
    // ワイド 上位3頭BOX(3点) a-b,a-c,b-c
    {
      let ret = 0; const pairs = [[a, b], [a, c], [b, c]];
      for (const [x, y] of pairs) if (top3Set.has(x) && top3Set.has(y)) ret += wideAmt(x, y);
      tally(S.wideBox3, 3, ret > 0, ret);
    }
    // 馬連 本命-対抗(1-2着 順不同)
    tally(S.umaren12, 1, (top3Set.has(a) && top3Set.has(b)) && ((a === r1 && b === r2) || (a === r2 && b === r1)), urenAmt(a, b));
    // 3連複 上位3頭BOX(1点)
    tally(S.trio3, 1, top3Set.has(a) && top3Set.has(b) && top3Set.has(c), trioAmt(a, b, c));
    // 3連複 上位4頭BOX(4点) = {a,b,c}{a,b,d}{a,c,d}{b,c,d}
    {
      const combos = [[a, b, c], [a, b, d], [a, c, d], [b, c, d]];
      let ret = 0; for (const [x, y, z] of combos) if (top3Set.has(x) && top3Set.has(y) && top3Set.has(z)) ret += trioAmt(x, y, z);
      tally(S.trio4, 4, ret > 0, ret);
    }
    // 3連複 上位5頭BOX(10点)
    {
      const five = [a, b, c, d, e].filter(x => x != null);
      let ret = 0, pts = 0;
      for (let i = 0; i < five.length; i++) for (let j = i + 1; j < five.length; j++) for (let k = j + 1; k < five.length; k++) {
        pts++; const x = five[i], y = five[j], z = five[k];
        if (top3Set.has(x) && top3Set.has(y) && top3Set.has(z)) ret += trioAmt(x, y, z);
      }
      if (pts > 0) tally(S.trio5, pts, ret > 0, ret);
    }
    // 3連複 軸1頭(本命)-相手 b,c,d,e(6点) = a と {b,c,d,e}から2頭
    {
      const others = [b, c, d, e].filter(x => x != null);
      let ret = 0, pts = 0;
      for (let i = 0; i < others.length; i++) for (let j = i + 1; j < others.length; j++) {
        pts++; const y = others[i], z = others[j];
        if (top3Set.has(a) && top3Set.has(y) && top3Set.has(z)) ret += trioAmt(a, y, z);
      }
      if (pts > 0) tally(S.trioF1, pts, ret > 0, ret);
    }
    // 3連単 本命→対抗→単穴(1点)
    tally(S.tan3_123, 1, (a === r1 && b === r2 && c === r3), tan3Amt(a, b, c));
    // 3連単 1着=本命固定, 2-3着= {b,c,d} の順列(6点)
    {
      const others = [b, c, d].filter(x => x != null);
      let ret = 0, pts = 0;
      for (const y of others) for (const z of others) {
        if (y === z) continue; pts++;
        if (a === r1 && y === r2 && z === r3) ret += tan3Amt(a, y, z);
      }
      if (pts > 0) tally(S.tan3_F, pts, ret > 0, ret);
    }
  }

  const pct = (x) => (x * 100).toFixed(1) + "%";
  console.log(`\n=== 勝てる馬券バックテスト (${useCal ? "較正勝率" : "市場de-vig"}・${used}レース / スキップ${skipped}) ===`);
  console.log(`回収率100%超なら「儲かる」。控除20〜30%があるので100%超は至難。\n`);
  console.log(`戦略                                  的中率    回収率    収支(1点100円)`);
  const rows = Object.values(S).sort((x, y) => (y.ret / Math.max(1, y.cost)) - (x.ret / Math.max(1, x.cost)));
  for (const s of rows) {
    if (s.bets === 0) continue;
    const roi = s.ret / Math.max(1, s.cost);
    const hit = s.hits / s.bets;
    const pnl = s.ret - s.cost;
    const flag = roi >= 1 ? " ★プラス!" : "";
    console.log(
      s.label.padEnd(34) +
      pct(hit).padStart(7) + "  " +
      pct(roi).padStart(8) + "  " +
      `${pnl >= 0 ? "+" : ""}${Math.round(pnl).toLocaleString()}円`.padStart(14) + flag
    );
  }
  console.log(`\n※回収率 = 払戻総額 ÷ 賭けた総額。全戦略「毎レース機械的に買った場合」。`);
  console.log(`  プラスが出たら、次は「自信のある時だけ買う(エッジ抽出)」でさらに伸ばせるか検証する。`);
}

main();
