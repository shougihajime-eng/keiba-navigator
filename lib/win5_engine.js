"use strict";

// WIN5 専用予想エンジン (Wave15.1 拡張版)
//
// 仕様:
//   - WIN5 は日曜開催の指定 5 レースの 1 着馬を 5 つすべて当てる馬券
//   - 1 点 200 円, 払戻平均 ~800 万円 (キャリーオーバー時 6 億円)
//
// 戦略:
//   safe   = 各レース 1 頭 (1×1×1×1×1 = 1 点 ¥200)
//   axis   = 軸 1 頭流し (信頼度上位 2 R は 1 頭、残り 3 R は 2 頭 = 8 点 ¥1,600)
//   mid    = 各レース 2 頭 (2^5 = 32 点 ¥6,400)
//   wide   = 各レース 3 頭 (3^5 = 243 点 ¥48,600)
//   custom = 予算指定の自動最適化 (greedy で信頼度低い順に頭数増やす)
//
// モード:
//   ev   = 期待値 (evRatio) 最大の戦略を推奨
//   hit  = 的中確率 (hitProb) 最大の戦略を推奨

const { buildConclusion } = require("./conclusion");

const EXPECTED_AVG_PAYOUT_PER_HIT = 8_000_000;  // 平均 800 万円 (歴史的)
const POINT_PRICE = 200;                        // 1 点 200 円

// 各レースの perRace 配列を作る
function buildPerRace(races) {
  const conclusions = races.map(r => {
    try { return buildConclusion(r); } catch { return null; }
  });
  return conclusions.map((c, idx) => {
    if (!c || !c.ok) return { idx, ok: false, race: races[idx], note: c?.verdictReason || "判定不可" };
    // 全出走馬の勝率順リストがあれば最優先 (中位馬も流し対象に含める)。無ければ従来の寄せ集め。
    const allHorses = (Array.isArray(c.allHorses) && c.allHorses.length)
      ? c.allHorses
      : [...(c.picks || []), ...(c.avoid || []), ...(c.overpopular || []), ...(c.undervalued || [])];
    const seen = new Set();
    const merged = [];
    for (const h of allHorses) {
      if (!h || seen.has(h.number)) continue;
      seen.add(h.number);
      merged.push(h);
    }
    merged.sort((a, b) => (b.prob ?? 0) - (a.prob ?? 0));
    return {
      idx, ok: true, race: races[idx],
      conclusion: c,
      raceName: c.raceMeta?.raceName || races[idx]?.race_name || `R${idx+1}`,
      top1: merged[0] || null,
      top2: merged[1] || null,
      top3: merged[2] || null,
      ranked: merged.slice(0, 8),
      confidence: c.confidence,
    };
  });
}

// plan = [k1, k2, k3, k4, k5] (各レースの top K) → 戦略結果
function computeWithPlan(perRace, plan) {
  if (!Array.isArray(plan) || plan.length !== perRace.length) return null;
  let logProbSum = 0;
  let combo = 1;
  const picksPerRace = [];
  for (let i = 0; i < perRace.length; i++) {
    const r = perRace[i];
    if (!r.ok) return null;
    const k = Math.max(1, Math.min(plan[i] || 1, r.ranked.length));
    const horses = r.ranked.slice(0, k).filter(h => h && Number.isFinite(h.prob));
    if (horses.length === 0) return null;
    const pSum = Math.min(1.0, horses.reduce((a, h) => a + h.prob, 0));
    logProbSum += Math.log(Math.max(pSum, 1e-12));
    combo *= horses.length;
    picksPerRace.push({
      raceIdx: r.idx,
      raceName: r.raceName,
      topK: k,
      picks: horses.map(h => ({ number: h.number, name: h.name, prob: h.prob, odds: h.odds })),
      groupProb: pSum,
    });
  }
  const hitProb = Math.exp(logProbSum);
  const totalCost = combo * POINT_PRICE;
  const expectedReturn = hitProb * EXPECTED_AVG_PAYOUT_PER_HIT;
  const evRatio = totalCost > 0 ? expectedReturn / totalCost : 0;
  return {
    plan, combo, totalCost,
    hitProb,
    hitProbPct: (hitProb * 100).toFixed(hitProb < 0.001 ? 6 : 4) + "%",
    expectedReturn,
    evRatio,
    picksPerRace,
  };
}

// 軸 1 頭流しの plan を構築: 信頼度上位 2R は 1 頭、残りは 2 頭
function buildAxisPlan(perRace) {
  if (perRace.length === 0) return null;
  const indexed = perRace.map((r, i) => ({ i, conf: r.confidence || 0 }));
  // 信頼度降順
  indexed.sort((a, b) => b.conf - a.conf);
  const plan = new Array(perRace.length).fill(2);
  // 上位 2 レースは 1 頭
  for (let j = 0; j < Math.min(2, indexed.length); j++) plan[indexed[j].i] = 1;
  return plan;
}

// 予算 (円) 内に収まる最大の plan を greedy で構築
//   - 開始: 全レース 1 頭 (1 点)
//   - 繰り返し: 信頼度の低いレースから top K を 1 ずつ増やしてみる
//   - 予算オーバーする手前で止める
function buildBudgetPlan(perRace, budgetYen) {
  if (!Number.isFinite(budgetYen) || budgetYen < POINT_PRICE) return null;
  const maxPoints = Math.floor(budgetYen / POINT_PRICE);
  if (maxPoints < 1) return null;
  const plan = new Array(perRace.length).fill(1);
  // 信頼度昇順 (低い順) で広げる
  const order = perRace.map((r, i) => ({ i, conf: r.confidence || 0 }))
    .sort((a, b) => a.conf - b.conf);
  const pointsOf = (p) => p.reduce((a, k) => a * k, 1);
  let safety = 30;
  while (pointsOf(plan) < maxPoints && safety-- > 0) {
    let progressed = false;
    for (const o of order) {
      const r = perRace[o.i];
      const limit = Math.min(5, r.ranked?.length || 1);
      if (plan[o.i] >= limit) continue;
      const next = [...plan];
      next[o.i]++;
      if (pointsOf(next) <= maxPoints) {
        plan[o.i]++;
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  return plan;
}

// メイン
function buildWin5(races, options = {}) {
  const perRace = buildPerRace(races);
  const allOk = perRace.length > 0 && perRace.every(r => r.ok);

  const strategies = {};
  if (allOk) {
    strategies.safe = computeWithPlan(perRace, new Array(perRace.length).fill(1));
    strategies.axis = computeWithPlan(perRace, buildAxisPlan(perRace));
    strategies.mid  = computeWithPlan(perRace, new Array(perRace.length).fill(2));
    strategies.wide = computeWithPlan(perRace, new Array(perRace.length).fill(3));
    if (Number.isFinite(options.budget) && options.budget >= POINT_PRICE) {
      const bp = buildBudgetPlan(perRace, options.budget);
      if (bp) {
        strategies.custom = computeWithPlan(perRace, bp);
        if (strategies.custom) strategies.custom._budget = options.budget;
      }
    }
    // 任意 plan を受け取る場合 (UI のカスタム編集)
    if (Array.isArray(options.customPlan) && options.customPlan.length === perRace.length) {
      strategies.userCustom = computeWithPlan(perRace, options.customPlan);
    }
  }
  // データ未揃の時は strategies を空のままにする (stub の hitProb=1 / evRatio=40000 は嘘)。
  // UI 側は ok=false なら戦略カードを描画しないので空でよい。

  // 推奨: mode = "ev" (期待値) | "hit" (的中確率)
  const mode = options.mode === "hit" ? "hit" : "ev";
  const sortKey = (s) => {
    if (!s) return -Infinity;
    if (mode === "hit") return s.hitProb;
    return s.evRatio;
  };
  const keys = Object.keys(strategies).filter(k => strategies[k]);
  keys.sort((a, b) => sortKey(strategies[b]) - sortKey(strategies[a]));
  const recommended = allOk ? keys[0] : null;

  const avgConfidence = perRace.reduce((a, r) => a + (r.confidence || 0), 0) / Math.max(1, perRace.length);

  return {
    ok: allOk,
    mode,
    budget: options.budget || null,
    perRace,
    strategies,
    recommended,
    avgConfidence,
    note: allOk
      ? `${nameOf(recommended)} を推奨 (${strategies[recommended].combo}点 / ¥${strategies[recommended].totalCost.toLocaleString("ja-JP")})`
      : "出走馬データが揃っていないレースがあります",
  };
}

// 戦略名 (UI 表示用)
function nameOf(key) {
  return {
    safe:       "堅め (本命固め)",
    axis:       "軸1頭流し",
    mid:        "中波 (2頭流し)",
    wide:       "万舟 (3頭流し)",
    custom:     "予算最適 (AI)",
    userCustom: "カスタム",
  }[key] || key;
}

// 表示用フォーマット
function formatWin5(win5) {
  if (!win5) return win5;
  const fmt = (key) => {
    const s = win5.strategies[key];
    if (!s) return null;
    return { ...s, name: nameOf(key) };
  };
  const out = { ...win5, strategies: {} };
  for (const key of Object.keys(win5.strategies)) {
    out.strategies[key] = fmt(key);
  }
  return out;
}

module.exports = {
  buildWin5,
  formatWin5,
  computeWithPlan,
  buildAxisPlan,
  buildBudgetPlan,
  EXPECTED_AVG_PAYOUT_PER_HIT,
  POINT_PRICE,
};
