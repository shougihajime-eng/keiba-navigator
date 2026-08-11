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
// 🚨 2026-08-11 訂正（ここには嘘が書いてあった）:
//   もとは「Harville は実測較正済(exotic_calibration)なので winProb≒実際の的中率。
//   よって ev = 実際の的中率 × オッズ ＝ 嘘のない期待値。」と書いてあったが、実際は
//     ・この overlay.js は exotic_calibration.json を一度も読んでいない
//       (較正を読んでいるのは lib/conclusion.js だけ)
//     ・そもそも exotic_calibration.json には wide と trio しか無く、
//       馬連(umaren)の較正表は存在しない
//   ＝ここで出している ev は「較正なしの生の Harville」であって、
//     「嘘のない期待値」ではない。あくまで“割安かもしれない候補”を挙げているだけ。
//   ⚠この ev を根拠に「勝てる」と言ってはいけない。
//   〔参考〕確率帯ごとに実測を当てた結果、馬連の Harville 確率は 実測/モデル = 0.89〜1.17
//           で大きくは外れていない（壊れてはいないが、較正済みではない）。
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
    const prob = EX.pQuinella(winProb, ns[0], ns[1]);
    if (prob < minProb) continue;
    const ev = prob * o;
    if (ev >= minEV) out.push({ type: "馬連", key: it.key, prob, odds: o, ev });
  }
  // ── ワイド（a,b がともに3着内）。payout 幅の小さい方(odds_low)で堅く見る ──
  for (const it of (odds.wide?.items) || []) {
    const ns = parseKey(it.key); if (ns.length !== 2) continue;
    const o = Number(it.odds_low); if (!(o > 1)) continue;
    const prob = EX.pWide(winProb, ns[0], ns[1]);
    if (prob < minProb) continue;
    const ev = prob * o;
    if (ev >= minEV) out.push({ type: "ワイド", key: it.key, prob, odds: o, ev, oddsHigh: Number(it.odds_high) || null });
  }
  // ── 3連複（a,b,c が1-2-3着・順不同）──
  for (const it of (odds.sanren?.items) || []) {
    const ns = parseKey(it.key); if (ns.length !== 3) continue;
    const o = Number(it.odds); if (!(o > 1)) continue;
    const prob = EX.pTrio(winProb, ns[0], ns[1], ns[2]);
    if (prob < minProb) continue;
    const ev = prob * o;
    if (ev >= minEV) out.push({ type: "3連複", key: it.key, prob, odds: o, ev });
  }

  out.sort((a, b) => b.ev - a.ev);
  return out;
}

module.exports = { buildWinProb, findOverlays, parseKey };
