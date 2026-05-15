"use strict";

/**
 * KEIBA NAVIGATOR — WIN5 予想ロジック
 *
 * WIN5 は JRA が指定する 5 レースで「すべての 1 着馬」を当てる馬券。
 *  - 払戻最高: 6 億円 (キャリーオーバー時)
 *  - 通常配当: 数十万 〜 数百万円
 *  - 5 連勝のため的中率は極めて低い
 *
 * 本モジュールの責務:
 *  1) 5 つの conclusion (各レースの AI 判定) を受け取り、
 *     - 各レースの推奨 1 着馬 (top pick) を抽出
 *     - 各レースの 2 番手・3 番手候補 (フォーメーション買い用)
 *     - 5 連勝の合成確率
 *     - 想定配当範囲 (低/中/高)
 *     - EV 評価 (買うべきか・見送るべきか)
 *  2) フォーメーション買い目 (本命+対抗) を組み立てる
 *  3) 推奨購入金額 (Kelly)
 *
 * 入力スキーマ (各 conclusion):
 *   {
 *     raceName: string,
 *     picks: [
 *       { number, name, prob, ev, odds, confidence, grade, ... },
 *       ...
 *     ],
 *     confidence: number,
 *     ...
 *   }
 *
 * 出力:
 *   {
 *     legs: [
 *       { raceName, top: pick, alt: [pick, ...], probTop, probTop3 },
 *       ...
 *     ],
 *     combined: {
 *       probAllWin: number,       // 5 連勝の合成確率
 *       probAllWinPct: string,    // "0.034%"
 *       expectedPayoutLow:  number,
 *       expectedPayoutMid:  number,
 *       expectedPayoutHigh: number,
 *       ev: number,               // 期待値 (推奨ベース)
 *     },
 *     stake: {
 *       recommended: number,      // Kelly 推奨額
 *       narrative: string,        // 「狙う / 様子見 / 見送り」
 *     },
 *     formation: {
 *       cells: number,            // 買い目点数
 *       desc: string,             // "本命×本命×本命×本命×本命" 等
 *     },
 *   }
 */

(function (global) {
  // 配当の想定レンジ (JRA WIN5 過去配当の経験則)
  const PAYOUT_LOW = 200000;        // 20万円 (人気サイド) -> 控えめな期待
  const PAYOUT_MID = 1500000;       // 150万円 (中間)
  const PAYOUT_HIGH = 20000000;     // 2000万円 (波乱)

  function safeProb(p) {
    if (!Number.isFinite(p)) return 0;
    return Math.max(0, Math.min(1, p));
  }

  // 1 レース分の "leg" を作る
  function buildLeg(conclusion, idx) {
    const picks = Array.isArray(conclusion?.picks) ? conclusion.picks : [];
    const sorted = picks.slice().sort((a, b) => (b.prob ?? 0) - (a.prob ?? 0));
    const top = sorted[0] || null;
    const alt = sorted.slice(1, 3);   // 2-3 番手
    const probTop = top ? safeProb(top.prob) : 0;
    const probTop3 = sorted.slice(0, 3).reduce((s, p) => s + safeProb(p.prob), 0);
    return {
      legIndex: idx + 1,
      raceName: conclusion?.raceName || conclusion?.race_name || `第${idx + 1}R`,
      top,
      alt,
      probTop,
      probTop3,
      confidence: conclusion?.confidence ?? null,
    };
  }

  function combineProbs(legs, getProb) {
    return legs.reduce((acc, l) => acc * (getProb(l) || 0), 1);
  }

  // フォーメーション買い目: 各 leg で何頭ずつ買うか
  function buildFormation(legs) {
    // 推奨フォーメーション: 信頼度高い leg は 1 頭, 低い leg は 2-3 頭
    let cells = 1;
    const detail = legs.map(l => {
      const conf = l.confidence ?? 0.5;
      if (conf >= 0.7) { cells *= 1; return "本命"; }
      if (conf >= 0.4) { cells *= 2; return "本命+対抗"; }
      cells *= 3; return "本命+対抗+穴";
    });
    return {
      cells,
      desc: detail.join(" × "),
      cost: cells * 100,  // WIN5 は 1 点 100 円
    };
  }

  // 想定配当 (人気度合いから推測)
  function expectedPayout(probAllWin) {
    if (!Number.isFinite(probAllWin) || probAllWin <= 0) return null;
    // フェアな配当 = 1 / probAllWin (税引前)
    const fair = 1 / probAllWin;
    // 実際の控除率 (~30%) を引く
    return Math.round(fair * 0.7);
  }

  function buildStakeNarrative(ev, probAllWin) {
    if (probAllWin < 0.00005) return "見送り (合成確率が著しく低い)";
    if (ev > 1.3) return "強く狙う (期待値 +30% 超)";
    if (ev > 1.1) return "狙う (期待値 +10〜30%)";
    if (ev > 0.9) return "様子見 (損益分岐圏)";
    return "見送り (期待値マイナス)";
  }

  // 3 戦略の組合せ計算 (堅/中/万)
  //   K = 1: 各レース 1 頭 → 1 点 (¥200)
  //   K = 2: 各レース 2 頭 → 32 点 (¥6,400)
  //   K = 3: 各レース 3 頭 → 243 点 (¥48,600)
  function computeStrategy(legs, topK) {
    let probSum = 1;
    let combo = 1;
    const picksPerRace = legs.map(l => {
      const picks = Array.isArray(l._allRanked) ? l._allRanked : [l.top, ...(l.alt || [])].filter(Boolean);
      const k = Math.min(topK, picks.length);
      if (k === 0) { probSum = 0; combo = 0; return null; }
      const chosen = picks.slice(0, k);
      const pSum = chosen.reduce((s, p) => s + safeProb(p.prob), 0);
      probSum *= Math.min(1, pSum);
      combo *= k;
      return {
        raceName: l.raceName,
        picks: chosen,
        groupProb: pSum,
      };
    });
    const totalCost = combo * 200;
    // 想定平均払戻 (経験則 800 万円)
    const expectedPayout = 8_000_000;
    const expectedReturn = probSum * expectedPayout;
    const evRatio = totalCost > 0 ? expectedReturn / totalCost : 0;
    return {
      topK, combo, totalCost,
      hitProb: probSum,
      hitProbPct: (probSum * 100).toFixed(4) + "%",
      expectedReturn,
      evRatio,
      picksPerRace,
    };
  }

  function compute(conclusions) {
    if (!Array.isArray(conclusions) || conclusions.length === 0) {
      return null;
    }
    // WIN5 は 5 レースだが、4 レースでも 3 レースでも一応計算する
    const arr = conclusions.slice(0, 5);
    const legs = arr.map((c, idx) => {
      const leg = buildLeg(c, idx);
      // 全候補を prob 順で _allRanked にも入れる (3戦略計算用)
      const picks = Array.isArray(c?.picks) ? c.picks : [];
      const avoid = Array.isArray(c?.avoid) ? c.avoid : [];
      const over  = Array.isArray(c?.overpopular) ? c.overpopular : [];
      const under = Array.isArray(c?.undervalued) ? c.undervalued : [];
      const all = [...picks, ...avoid, ...over, ...under];
      const seen = new Set();
      const dedup = [];
      for (const h of all) {
        if (!h || seen.has(h.number)) continue;
        seen.add(h.number);
        dedup.push(h);
      }
      dedup.sort((a, b) => (b.prob ?? 0) - (a.prob ?? 0));
      leg._allRanked = dedup;
      return leg;
    });

    const probAllWin = combineProbs(legs, l => l.probTop);
    const probAllWinFormation = combineProbs(legs, l => l.probTop3);

    const fairPayout = expectedPayout(probAllWin);
    const ev = (fairPayout != null) ? (probAllWin * fairPayout) : null;

    const formation = buildFormation(legs);

    // ★3 戦略 (堅/中/万) の計算
    const strategies = legs.length === 5 ? {
      safe: computeStrategy(legs, 1),
      mid:  computeStrategy(legs, 2),
      wide: computeStrategy(legs, 3),
    } : null;
    // 推奨戦略 (evRatio 最大のもの)
    let recommended = null;
    if (strategies) {
      const arr = ["safe", "mid", "wide"];
      arr.sort((a, b) => strategies[b].evRatio - strategies[a].evRatio);
      recommended = arr[0];
    }

    return {
      legs,
      combined: {
        probAllWin,
        probAllWinPct: (probAllWin * 100).toFixed(4) + "%",
        probAllWinFormation,
        probAllWinFormationPct: (probAllWinFormation * 100).toFixed(3) + "%",
        expectedPayoutLow:  PAYOUT_LOW,
        expectedPayoutMid:  PAYOUT_MID,
        expectedPayoutHigh: PAYOUT_HIGH,
        expectedPayoutFair: fairPayout,
        ev: ev != null ? ev : 0,
      },
      formation,
      strategies,
      recommended,
      stake: {
        recommendedCost: formation.cost,
        narrative: buildStakeNarrative(ev || 0, probAllWin),
      },
      generatedAt: new Date().toISOString(),
    };
  }

  // 結果を 1 行サマリ化
  function summarize(win5) {
    if (!win5) return "WIN5 データなし";
    const pct = win5.combined.probAllWinPct;
    const cost = win5.formation.cost;
    const verdict = win5.stake.narrative;
    return `${win5.legs.length} R フォーメーション ${cost}円 / 連勝率 ${pct} / ${verdict}`;
  }

  global.Win5 = { compute, summarize, _internal: { buildLeg, buildFormation, expectedPayout } };
})(typeof window !== "undefined" ? window : globalThis);
