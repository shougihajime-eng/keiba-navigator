"use strict";
// ============================================================
// overlay.js — 「うまみ（割安な組合せ）」発見器（Dr Ziemba / クロスプール方式）
//
// ★考え方（あの馬券裁判の勝者・ベンターと同じ核心）:
//   単勝プール(みんなのお金)は一番かしこい＝“本当の強さ”に近い。
//   その単勝から ディスカウントHarville で「組合せの本当の当たる確率」を作る。
//   一方、馬連/ワイド/3連複プールは“別の財布”で、群衆が値付けをよく間違える。
//   そこで「単勝由来の本当の確率 × その組合せのオッズ」が 1 を超える＝
//   “みんなが安く売りすぎた組合せ(うまみ)”＝買えば理屈上プラス、を見つける。
//
// 🚨 2026-08-11 訂正 → 2026-08-12 対処ずみ:
//   もとは「Harville は実測較正済なので ev = 嘘のない期待値」と書いてあったが、実際は
//   ①ここは較正を一度も読んでいない ②馬連の較正表がそもそも存在しない、の二重の嘘だった。
//   さらに ③lib/exotic.js の既定指数が 0.85/0.70 と古く、較正ファイル(0.92/0.62)と
//   食い違ったまま計算していた（＝ずっと古い数字で「うまみ」を出していた）。
//
//   2026-08-12 に馬連の較正表を作り、pQuinellaCal を通すようにした。
//   ⚠ワイドと3連複は「較正すると かえって悪くなる」とデータが言ったので較正していない
//     （Cal 版を呼んでも生の値が返る）。ベンター脚注3「片方だけ直すと悪化しうる」が実際に出た形。
//
//   ★それでも ev は「嘘のない期待値」ではない:
//     較正しても馬連はまだ 4.75% 多めに言う（6.91%→4.75% に減っただけ）。
//     これは安全余裕であって精度ではない。**この ev を根拠に「勝てる」と言ってはいけない。**
//   〔効き目の実測〕本物の馬連オッズがある431レース3,696点で、うまみ判定 510件→401件(−21.4%)。
//     109件は較正なしの水増しに乗っていた候補だった。
//
// 入力:
//   winProb : { 馬番: 勝率 }（単勝オッズをレース内で正規化したもの）
//   snap    : collect_exotic_odds.py が保存した {odds:{umaren,wide,sanren,...}}
// 出力: うまみ候補の配列（ev 降順）。
// ============================================================
const EX = require("./exotic");

// 単勝オッズ配列 → de-vig 勝率マップ（控除を抜いて合計1へ）
function buildWinProb(tanshoItems) {
  const p = {};
  let s = 0;
  for (const it of tanshoItems || []) {
    const o = Number(it.odds);
    if (Number.isFinite(o) && o > 1) { p[it.number] = 1 / o; s += 1 / o; }
  }
  if (s > 0) for (const k in p) p[k] /= s;
  return p;
}

// 組番文字列 "1-4" / "1-4-5" → 数値配列
function parseKey(key) {
  return String(key).split("-").map(Number).filter(n => Number.isFinite(n) && n > 0);
}

// うまみ候補を探す。
//   minEV: これ以上の期待値だけ採用（控除＋誤差マージン込みで 1.2 など）
//   minProb: あまりに当たらない目は除外（資金が溶ける）
function findOverlays(winProb, snap, opts = {}) {
  const minEV = opts.minEV ?? 1.20;
  const minProb = opts.minProb ?? 0.03;
  const out = [];
  const odds = (snap && snap.odds) || {};

  // ── 馬連（a,b が1-2着・順不同）──
  for (const it of (odds.umaren?.items) || []) {
    const ns = parseKey(it.key); if (ns.length !== 2) continue;
    const o = Number(it.odds); if (!(o > 1)) continue;
    const prob = EX.pQuinellaCal(winProb, ns[0], ns[1]);   // 2026-08-12 較正版に（生のHarvilleは6.91%多めに言う→4.75%に）
    if (prob < minProb) continue;
    const ev = prob * o;
    if (ev >= minEV) out.push({ type: "馬連", key: it.key, prob, odds: o, ev });
  }
  // ── ワイド（a,b がともに3着内）。payout 幅の小さい方(odds_low)で堅く見る ──
  for (const it of (odds.wide?.items) || []) {
    const ns = parseKey(it.key); if (ns.length !== 2) continue;
    const o = Number(it.odds_low); if (!(o > 1)) continue;
    const prob = EX.pWideCal(winProb, ns[0], ns[1]);       // ワイドは較正すると悪化するのでCal版でも生の値が返る（判定はデータ側）
    if (prob < minProb) continue;
    const ev = prob * o;
    if (ev >= minEV) out.push({ type: "ワイド", key: it.key, prob, odds: o, ev, oddsHigh: Number(it.odds_high) || null });
  }
  // ── 3連複（a,b,c が1-2-3着・順不同）──
  for (const it of (odds.sanren?.items) || []) {
    const ns = parseKey(it.key); if (ns.length !== 3) continue;
    const o = Number(it.odds); if (!(o > 1)) continue;
    const prob = EX.pTrioCal(winProb, ns[0], ns[1], ns[2]); // 3連複も同上
    if (prob < minProb) continue;
    const ev = prob * o;
    if (ev >= minEV) out.push({ type: "3連複", key: it.key, prob, odds: o, ev });
  }

  out.sort((a, b) => b.ev - a.ev);
  return out;
}

module.exports = { buildWinProb, findOverlays, parseKey };
