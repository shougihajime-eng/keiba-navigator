"use strict";
// ============================================================
// exotic.js — 単勝の勝率から「連系・3連系」馬券の確率を作る(Harville モデル)。
//
// ★なぜこれが「勝ちに行く」核心か(Bill Benter の手法):
//   単勝オッズ(みんなのお金)は超優秀な勝率予測。これを土台に Harville 公式で
//   「2着・3着・組合せ」の確率を作り、群衆の予想が雑になりがちな exotic(3連複等)で
//   “みんなが間違えている組合せ”を狙う。単勝より控除の壁を越えやすい唯一の道。
//
// Harville(1973) の独立仮定:
//   P(1着=a) = p_a
//   P(a→b の順) = p_a * p_b/(1-p_a)
//   P(a→b→c)   = p_a * p_b/(1-p_a) * p_c/(1-p_a-p_b)
//
// ★ディスカウントHarville (Lo & Bacon-Shone 2007 / Henery補正):
//   素のHarvilleは「人気馬が2・3着に来る確率」を過大評価する系統誤差がある。
//   後続着順の勝率項に べき指数(LAM,TAU < 1)をかけて人気馬の効きを弱める:
//     P(a→b)   ∝ p_a · p_b^LAM
//     P(a→b→c) ∝ p_a · p_b^LAM · p_c^TAU
//   LAM=TAU=1 で素のHarvilleに一致。Heneryの推定で 2着用 LAM≈0.76。
//   実データで較正した値を使う(scripts/build-exotic-calibration.cjs)。
//
// 入力 probMap: { 馬番: 勝率 }(レース内で正規化済み・合計≒1)。
// すべて純粋関数・副作用なし。
// ============================================================

// ディスカウント指数(2・3着項にかけるべき)。実データ較正で更新可。
// 1.0=素のHarville。<1 で人気馬の2・3着過大評価を補正。
// 既定値は build-exotic-calibration.cjs が過去3747レースで較正した最良値
// (素のHarville比で予想→実測のズレを 14.4pt → 1.0pt に縮小)。
let LAM = 0.85; // 2着項
let TAU = 0.70; // 3着項
function setDiscount(lam, tau) {
  if (Number.isFinite(lam) && lam > 0) LAM = lam;
  if (Number.isFinite(tau) && tau > 0) TAU = tau;
}
function getDiscount() { return { lam: LAM, tau: TAU }; }

function _vals(probMap) {
  // [{n, p}] 配列(pは0以上)。合計を1へ正規化して返す。
  const arr = Object.keys(probMap).map(k => ({ n: Number(k), p: Math.max(0, Number(probMap[k]) || 0) }));
  const s = arr.reduce((a, x) => a + x.p, 0);
  if (s > 0) for (const x of arr) x.p = x.p / s;
  return arr;
}

// 単勝勝率(a が1着)
function pWin(probMap, a) { const p = Number(probMap[a]); return Number.isFinite(p) ? p : 0; }

// 馬単(a→b の正確な順)・ディスカウントHarville
//   P(a→b) = p_a · p_b^LAM / Σ_{s≠a} p_s^LAM
function pExacta(probMap, a, b) {
  const pa = pWin(probMap, a), pb = pWin(probMap, b);
  if (pa <= 0 || pb <= 0) return 0;
  let denom = 0;
  for (const k in probMap) {
    const n = Number(k); if (n === Number(a)) continue;
    const p = Math.max(0, Number(probMap[k]) || 0);
    if (p > 0) denom += Math.pow(p, LAM);
  }
  if (denom <= 1e-12) return 0;
  return pa * (Math.pow(pb, LAM) / denom);
}

// 馬連(a,b が1-2着・順不同)
function pQuinella(probMap, a, b) {
  return pExacta(probMap, a, b) + pExacta(probMap, b, a);
}

// 3連単(a→b→c の正確な順)・ディスカウントHarville
//   P(a→b→c) = p_a · p_b^LAM/Σ_{s≠a}p_s^LAM · p_c^TAU/Σ_{t≠a,b}p_t^TAU
function pTrifecta(probMap, a, b, c) {
  const pa = pWin(probMap, a), pb = pWin(probMap, b), pc = pWin(probMap, c);
  if (pa <= 0 || pb <= 0 || pc <= 0) return 0;
  const A = Number(a), B = Number(b);
  let d1 = 0, d2 = 0;
  for (const k in probMap) {
    const n = Number(k);
    const p = Math.max(0, Number(probMap[k]) || 0);
    if (p <= 0) continue;
    if (n !== A) d1 += Math.pow(p, LAM);
    if (n !== A && n !== B) d2 += Math.pow(p, TAU);
  }
  if (d1 <= 1e-12 || d2 <= 1e-12) return 0;
  return pa * (Math.pow(pb, LAM) / d1) * (Math.pow(pc, TAU) / d2);
}

// 3連複({a,b,c} が1-3着・順不同) = 6通りの3連単の和
function pTrio(probMap, a, b, c) {
  return (
    pTrifecta(probMap, a, b, c) + pTrifecta(probMap, a, c, b) +
    pTrifecta(probMap, b, a, c) + pTrifecta(probMap, b, c, a) +
    pTrifecta(probMap, c, a, b) + pTrifecta(probMap, c, b, a)
  );
}

// a が3着以内(複勝相当) = Σ_{b<c, b,c≠a} pTrio(a,b,c)
function pTop3(probMap, a) {
  const arr = _vals(probMap).filter(x => x.n !== Number(a));
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      s += pTrio(probMap, a, arr[i].n, arr[j].n);
    }
  }
  return s;
}

// ワイド(a,b がともに3着以内・順不同) = Σ_{c≠a,b} pTrio(a,b,c)
function pWide(probMap, a, b) {
  const arr = _vals(probMap).filter(x => x.n !== Number(a) && x.n !== Number(b));
  let s = 0;
  for (const x of arr) s += pTrio(probMap, a, b, x.n);
  return s;
}

// 勝率降順に並べた馬番配列(本命→対抗→…)。
function rankByProb(probMap) {
  return _vals(probMap).sort((x, y) => y.p - x.p).map(x => x.n);
}

module.exports = {
  pWin, pExacta, pQuinella, pTrifecta, pTrio, pTop3, pWide, rankByProb,
  setDiscount, getDiscount,
};
