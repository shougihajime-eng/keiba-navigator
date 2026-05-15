"use strict";

// WIN5 専用予想エンジン
//
// 仕様:
//   - WIN5 は日曜開催の指定 5 レースの 1 着馬を 5 つすべて当てる馬券
//   - 払戻: キャリーオーバーで億超え常襲 (平均 1,000 万円〜数千万円)
//   - 賭式: 1 通り 200 円 (税抜表示は 100 円)
//
// このエンジンは:
//   (1) 各レースの推定勝率 TopN (predictor 経由) を取得
//   (2) 組み合わせ確率と期待払戻を計算
//   (3) 「堅め (1×1×1×1×1=1点)」「中波 (2×2×2×2×2=32点)」「万舟 (3×3×3×3×3=243点)」
//        の 3 戦略の推奨を出す
//   (4) 各組合せの当選確率 × 想定平均払戻 ÷ 投票額 = 期待値 を計算

const { buildConclusion } = require("./conclusion");

// 想定平均払戻 (キャリーオーバー無しの理論期待値)
//   公式控除率 約 30% を考慮し、組合せ数の逆数からの理論期待値より低めに見積もる
//   ※ キャリーオーバー時は別途加算するため、ベースは控えめに
const EXPECTED_AVG_PAYOUT_PER_HIT = 8_000_000;  // 平均 800 万円 (歴史的)

// 5 レースの conclusion 配列から WIN5 予想を作る
function buildWin5(races, options = {}) {
  const conclusions = races.map(r => {
    try { return buildConclusion(r); } catch { return null; }
  });

  // 各レースの prob ranking (top3) を取得
  const perRace = conclusions.map((c, idx) => {
    if (!c || !c.ok) return { idx, ok: false, race: races[idx], note: c?.verdictReason || "判定不可" };
    // picks + avoid を統合して prob 順 top3 を作る
    const allHorses = [...(c.picks || []), ...(c.avoid || []), ...(c.overpopular || []), ...(c.undervalued || [])];
    // dedupe by number
    const seen = new Set();
    const merged = [];
    for (const h of allHorses) {
      if (!h || seen.has(h.number)) continue;
      seen.add(h.number);
      merged.push(h);
    }
    // prob 降順
    merged.sort((a, b) => (b.prob ?? 0) - (a.prob ?? 0));
    return {
      idx, ok: true, race: races[idx],
      conclusion: c,
      raceName: c.raceMeta?.raceName || races[idx]?.race_name || `R${idx+1}`,
      top1: merged[0] || null,
      top2: merged[1] || null,
      top3: merged[2] || null,
      ranked: merged.slice(0, 6),
      confidence: c.confidence,
    };
  });

  // 5 戦すべてが ok でないと WIN5 は組めない (空配列は ok:false)
  const allOk = perRace.length > 0 && perRace.every(r => r.ok);

  // 各戦略の当選確率と組合せ数を計算
  function computeStrategy(topK) {
    let probSum = 1.0;       // 当選確率の積
    let combo = 1;           // 組合せ数 (=点数)
    const picksPerRace = [];
    for (const r of perRace) {
      if (!r.ok) { probSum = 0; combo = 0; break; }
      const horses = r.ranked.slice(0, topK).filter(h => h && Number.isFinite(h.prob));
      if (horses.length === 0) { probSum = 0; break; }
      // 「topK 内の馬の少なくとも 1 頭が 1 着になる確率」 ≒ 上位K頭の prob の合計
      const pSum = horses.reduce((a, h) => a + h.prob, 0);
      probSum *= Math.min(1.0, pSum);
      combo *= horses.length;
      picksPerRace.push({
        raceIdx: r.idx,
        raceName: r.raceName,
        picks: horses.map(h => ({ number: h.number, name: h.name, prob: h.prob, odds: h.odds })),
        groupProb: pSum,
      });
    }
    const totalCost = combo * 200;  // 1 点 200 円
    const ev = probSum * EXPECTED_AVG_PAYOUT_PER_HIT;
    const evRatio = totalCost > 0 ? ev / totalCost : 0;
    return {
      topK, combo, totalCost,
      hitProb: probSum,
      expectedReturn: ev,
      evRatio,
      picksPerRace,
    };
  }

  const strategies = {
    safe:    computeStrategy(1),   // 1×1×1×1×1 = 1 点 (¥200)
    mid:     computeStrategy(2),   // 2^5 = 32 点 (¥6,400)
    wide:    computeStrategy(3),   // 3^5 = 243 点 (¥48,600)
  };

  // 推奨: ev_ratio が最大のもの (ただし軍資金制約は使用者側で判断)
  const sortedByEv = ["safe", "mid", "wide"].sort((a, b) => strategies[b].evRatio - strategies[a].evRatio);
  const recommended = allOk ? sortedByEv[0] : null;

  // 信頼度: 5 レースの平均
  const avgConfidence = perRace.reduce((a, r) => a + (r.confidence || 0), 0) / Math.max(1, perRace.length);

  return {
    ok: allOk,
    perRace,
    strategies,
    recommended,
    avgConfidence,
    note: allOk
      ? `${recommended} 戦略推奨 (${strategies[recommended].combo}点 / ¥${strategies[recommended].totalCost.toLocaleString("ja-JP")})`
      : "出走馬データが揃っていないレースがあります",
  };
}

// 表示用フォーマット
function formatWin5(win5) {
  if (!win5 || !win5.ok) return win5;
  const fmt = (s) => ({
    name: s === "safe" ? "堅め (本命固め)" : s === "mid" ? "中波 (1着候補2頭)" : "万舟 (3頭流し)",
    ...win5.strategies[s],
  });
  return {
    ...win5,
    strategies: {
      safe: fmt("safe"),
      mid:  fmt("mid"),
      wide: fmt("wide"),
    },
  };
}

module.exports = { buildWin5, formatWin5, EXPECTED_AVG_PAYOUT_PER_HIT };
