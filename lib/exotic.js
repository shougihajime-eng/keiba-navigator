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
// 既定値は build-exotic-calibration.cjs が過去4248レースで較正した最良値。
// ⚠この既定値は「exotic_calibration.json を読めなかったとき」の保険。
//   本来は loadCalibration() が同ファイルの discount を入れて上書きする。
//   (2026-08-12: 既定が 0.85/0.70 のまま古く、較正ファイル(0.92/0.62)と食い違っていた。
//    overlay.js は較正を読んでいなかったので、ずっと古い指数で計算していた。)
// 〔独立した裏付け〕Benter が香港3,198レースで最尤推定した補正指数 γ=0.81 / δ=0.65 と近い。
let LAM = 0.92; // 2着項
let TAU = 0.62; // 3着項
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

// ============================================================
// 🚀 高速版(ctx)。同じレースの組合せを何百・何万通りも回すとき用。
//   上の pExacta/pTrifecta は 1 回ごとに probMap 全体をなめて分母を作るので、
//   全組合せを評価すると O(N^2)〜O(N^3) になり、較正表づくり(38万ペア/190万3連)が重い。
//   分母は「全体の和 − 除く馬」で作れるので、レースごとに 1 回だけ和を出しておく。
//   ⚠式は上の関数と完全に同じ。
//     build-exotic-calibration.cjs が毎回 遅い版と突き合わせて一致を確かめる
//     (実装を2つ持つときは必ず機械で照合する)。
// ============================================================
function makeCtx(probMap) {
  const nums = [];
  const p = new Map();
  let SL = 0, ST = 0;
  for (const k in probMap) {
    const n = Number(k);
    const raw = Number(probMap[k]);
    const v = Number.isFinite(raw) ? raw : 0;   // pWin と同じ扱い
    const vpos = Math.max(0, v);                // 分母側は Math.max(0,..) と同じ扱い
    nums.push(n);
    p.set(n, { v, L: vpos > 0 ? Math.pow(vpos, LAM) : 0, T: vpos > 0 ? Math.pow(vpos, TAU) : 0 });
    SL += p.get(n).L;
    ST += p.get(n).T;
  }
  return { nums, p, SL, ST, lam: LAM, tau: TAU };
}

function ctxExacta(ctx, a, b) {
  const A = ctx.p.get(Number(a)), B = ctx.p.get(Number(b));
  if (!A || !B || A.v <= 0 || B.v <= 0) return 0;
  const d1 = ctx.SL - A.L;
  if (d1 <= 1e-12) return 0;
  return A.v * (B.L / d1);
}

function ctxQuinella(ctx, a, b) { return ctxExacta(ctx, a, b) + ctxExacta(ctx, b, a); }

function ctxTrifecta(ctx, a, b, c) {
  const A = ctx.p.get(Number(a)), B = ctx.p.get(Number(b)), C = ctx.p.get(Number(c));
  if (!A || !B || !C || A.v <= 0 || B.v <= 0 || C.v <= 0) return 0;
  const d1 = ctx.SL - A.L;
  const d2 = ctx.ST - A.T - B.T;
  if (d1 <= 1e-12 || d2 <= 1e-12) return 0;
  return A.v * (B.L / d1) * (C.T / d2);
}

function ctxTrio(ctx, a, b, c) {
  return (
    ctxTrifecta(ctx, a, b, c) + ctxTrifecta(ctx, a, c, b) +
    ctxTrifecta(ctx, b, a, c) + ctxTrifecta(ctx, b, c, a) +
    ctxTrifecta(ctx, c, a, b) + ctxTrifecta(ctx, c, b, a)
  );
}

function ctxWide(ctx, a, b) {
  const A = Number(a), B = Number(b);
  let s = 0;
  for (const n of ctx.nums) { if (n !== A && n !== B) s += ctxTrio(ctx, A, B, n); }
  return s;
}

// ============================================================
// 📏 実測較正(exotic_calibration.json)。
//   ディスカウントHarville の確率は「だいたい合っている」が、
//   overlay が見る帯(p>=3%)では 実測より 5〜9% 高く出る系統のクセがある。
//   期待値のしきい値(minEV 1.20)を跨ぐかどうかに直に効くので、
//   実測で作ったカーブで写してから期待値を計算する。
//
// 🚨 Benter の警告(脚注3)を踏まえた設計:
//   「Harville の偏り」と「穴馬バイアス(市場が穴を買いすぎる)」は互いに打ち消し合う。
//   だから片方だけを式でいじると、もう片方が露出して悪化しうる。
//   → ここでは式をいじらず、**同じ入口(市場de-vig勝率)から出した確率を
//     そのまま実測の的中率へ写す**。つまり2つの偏りの“差し引きの結果”を丸ごと補正する。
//     片方だけを直すことにならないので、この警告を踏み外さない。
// ============================================================
let _CAL = null, _CAL_TRIED = false;
function loadCalibration(force) {
  if (_CAL_TRIED && !force) return _CAL;
  _CAL_TRIED = true;
  try {
    const c = require("../data/jv_cache/exotic_calibration.json");
    _CAL = (c && typeof c === "object") ? c : null;
    // 較正表を作ったときの指数に必ず合わせる(ここがズレると較正の意味が消える)
    if (_CAL && _CAL.discount) setDiscount(_CAL.discount.lam, _CAL.discount.tau);
  } catch { _CAL = null; }
  return _CAL;
}

// カーブ(節点の並び)で p を写す。
//   bins: [{pMid, rate}, ...] pMid 昇順。pMid=その帯の平均予想確率, rate=その帯の実測的中率。
//   ・節点の間 → 直線でつなぐ
//   ・いちばん下より小さい / いちばん上より大きい → その節点の倍率(rate/pMid)を掛ける
//     (p=0 は 0 のまま・上に外れても暴れない)
function applyCurve(p, bins) {
  const arr = Array.isArray(bins) ? bins : (bins && Array.isArray(bins.bins) ? bins.bins : null);
  if (!arr || !arr.length || !Number.isFinite(p) || p <= 0) return p;
  const k = arr.filter(b => Number.isFinite(b.pMid) && b.pMid > 0 && Number.isFinite(b.rate));
  if (!k.length) return p;
  if (p <= k[0].pMid) return Math.min(1, p * (k[0].rate / k[0].pMid));
  const last = k[k.length - 1];
  if (p >= last.pMid) return Math.min(1, p * (last.rate / last.pMid));
  for (let i = 1; i < k.length; i++) {
    if (p <= k[i].pMid) {
      const a = k[i - 1], b = k[i];
      const t = (p - a.pMid) / (b.pMid - a.pMid);
      return Math.min(1, Math.max(0, a.rate + t * (b.rate - a.rate)));
    }
  }
  return p;
}

// overlay 用(全組合せを対象に作ったカーブ)を取り出す。無ければ null。
// ⚠ applied:false は「較正すると かえって悪くなると実測で分かった」券種。
//   その場合は較正せず生の値を返す (無理に直さないのが正解)。
function overlayCurve(kind) {
  const c = loadCalibration();
  const o = c && c.overlay;
  const e = o && o[kind];
  if (!e || e.applied === false) return null;
  return (Array.isArray(e.bins) && e.bins.length) ? e.bins : null;
}

// 較正ずみの確率。カーブが無ければ生の値をそのまま返す(黙って壊れない)。
// ⚠ minP より下の帯は「そもそも測っていない/買い候補にならない」ので触らない。
//   (低い帯はクセの向きが逆で、同じ倍率をかけると かえって外れる)
function _calWith(kind, p) {
  const c = loadCalibration();
  const e = c && c.overlay && c.overlay[kind];
  if (!e || e.applied === false) return p;
  const bins = (Array.isArray(e.bins) && e.bins.length) ? e.bins : null;
  if (!bins || !Number.isFinite(p)) return p;
  const minP = Number.isFinite(e.minP) ? e.minP : 0;
  if (p < minP) return p;
  return applyCurve(p, bins);
}
function calQuinella(p) { return _calWith("umaren", p); }
function calWide(p)     { return _calWith("wide", p); }
function calTrio(p)     { return _calWith("trio", p); }

// ── overlay.js から呼ぶのはこの3つ ──────────────────────
//   使い方: EX.pQuinellaCal(winProb, a, b) → 実測較正ずみの「当たる確率」
//   ⚠ 呼んだ時点で exotic_calibration.json の discount(lam/tau)も自動で入る。
function pQuinellaCal(probMap, a, b) { loadCalibration(); return calQuinella(pQuinella(probMap, a, b)); }
function pWideCal(probMap, a, b)     { loadCalibration(); return calWide(pWide(probMap, a, b)); }
function pTrioCal(probMap, a, b, c)  { loadCalibration(); return calTrio(pTrio(probMap, a, b, c)); }

// 何で較正しているか(正直に画面/ログへ出す用)。較正が無いときは available:false。
function calibrationInfo() {
  const c = loadCalibration();
  const o = c && c.overlay;
  const one = (k) => {
    const e = o && o[k];
    return e ? { available: true, races: e.races ?? null, samples: e.samples ?? null,
                 bins: (e.bins || []).length, validation: e.validation ?? null } : { available: false };
  };
  return {
    available: !!o,
    generatedAt: (c && c.generatedAt) || null,
    discount: getDiscount(),
    umaren: one("umaren"), wide: one("wide"), trio: one("trio"),
  };
}

module.exports = {
  pWin, pExacta, pQuinella, pTrifecta, pTrio, pTop3, pWide, rankByProb,
  setDiscount, getDiscount,
  // 高速版(レース単位でまとめて回すとき)
  makeCtx, ctxExacta, ctxQuinella, ctxTrifecta, ctxTrio, ctxWide,
  // 実測較正
  loadCalibration, applyCurve, overlayCurve,
  calQuinella, calWide, calTrio,
  pQuinellaCal, pWideCal, pTrioCal, calibrationInfo,
};
