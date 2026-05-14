"use strict";
/**
 * KEIBA NAVIGATOR — バックテスト (ブラウザ実行)
 *
 * 役割:
 *   過去の確定済み馬券に対して「もし今の AI (校正済EV) で判定していたら」を再計算。
 *   - 元の判定 vs 今のAIの判定の差分を集計
 *   - 「今のAI」基準で買い/見送りを決めていたら回収率はどう変わるか
 *
 * 設計:
 *   - 仮データ (dummy) は除外
 *   - 確定済 (won/lost が入っている) のみ対象
 *   - 校正は Learner.computeCalibration から計算
 *
 * 公開 API:
 *   Backtest.run(bets) -> {
 *     evaluable, total,
 *     original:    { spent, returned, recovery, hits, samples },
 *     hypothetical:{ spent, returned, recovery, hits, samples },
 *     verdictDelta:{ stayBuy, stayPass, becamePass, becameBuy },
 *     improvement: number,
 *     insight:     string[],
 *   }
 */
(function (global) {
  function verdictOf(ev) { return (ev != null && ev >= 1.00) ? "buy" : "pass"; }

  function run(bets) {
    const cleaned = (Array.isArray(bets) ? bets : [])
      .filter(b => b && b.dataSource !== "dummy")
      .filter(b => b.result?.won === true || b.result?.won === false);

    const total = cleaned.length;
    if (!global.Learner?.computeCalibration) {
      return { evaluable: 0, total, error: "Learner module not available" };
    }
    const calib = global.Learner.computeCalibration(bets);

    let evaluable = 0;
    const orig = { spent: 0, returned: 0, hits: 0, samples: 0 };
    const hypo = { spent: 0, returned: 0, hits: 0, samples: 0 };
    const delta = { stayBuy: 0, stayPass: 0, becamePass: 0, becameBuy: 0 };

    for (const b of cleaned) {
      orig.samples += 1;
      orig.spent   += b.amount || 0;
      if (b.result.won) {
        orig.returned += b.result.payout || 0;
        orig.hits += 1;
      }

      const evOrig = (b.ev != null && Number.isFinite(Number(b.ev))) ? Number(b.ev)
                   : (b.prob != null && b.odds != null) ? b.prob * b.odds
                   : null;
      if (evOrig == null) continue;

      const grade = (global.Learner.gradeOf?.(b)) || null;
      const evNew = global.Learner.calibratedEV(grade, evOrig, calib);
      evaluable += 1;

      const vOrig = verdictOf(evOrig);
      const vNew  = verdictOf(evNew);

      if (vOrig === "buy"  && vNew === "buy")  delta.stayBuy   += 1;
      if (vOrig === "buy"  && vNew === "pass") delta.becamePass += 1;
      if (vOrig === "pass" && vNew === "pass") delta.stayPass  += 1;
      if (vOrig === "pass" && vNew === "buy")  delta.becameBuy += 1;

      if (vNew === "buy") {
        hypo.samples += 1;
        hypo.spent   += b.amount || 0;
        if (b.result.won) {
          hypo.returned += b.result.payout || 0;
          hypo.hits += 1;
        }
      }
    }

    const recovery = (s) => {
      if (!s || !s.spent || s.spent <= 0) return null;
      const r = s.returned / s.spent;
      return Number.isFinite(r) ? r : null;
    };
    const origRec = recovery(orig);
    const hypoRec = recovery(hypo);
    const improvement = (Number.isFinite(origRec) && Number.isFinite(hypoRec)) ? hypoRec - origRec : null;

    const insight = [];
    if (evaluable < 10) {
      insight.push(`評価可能な記録が ${evaluable} 件しかありません(10件以上で精度が出ます)。`);
    } else {
      if (delta.becamePass >= 1) {
        insight.push(`過去に「買い」と判定したうち <b>${delta.becamePass} 件</b> は、今のAIなら「見送り」に変わります。`);
      }
      if (delta.becameBuy >= 1) {
        insight.push(`過去に「見送り」と判定したうち <b>${delta.becameBuy} 件</b> は、今のAIなら「買い」に変わります。`);
      }
      if (Number.isFinite(improvement)) {
        const diffPct = (improvement * 100).toFixed(0);
        if (improvement > 0.03) {
          insight.push(`今のAIで買っていれば、回収率は <b>${(origRec*100).toFixed(0)}% → ${(hypoRec*100).toFixed(0)}%</b> に改善 (+${diffPct}%) — AI が育っています。`);
        } else if (improvement < -0.03) {
          insight.push(`今のAIで再評価すると回収率は <b>${(origRec*100).toFixed(0)}% → ${(hypoRec*100).toFixed(0)}%</b> に悪化 (${diffPct}%)。校正が過剰反応の可能性。`);
        } else {
          insight.push(`今のAIで再評価しても回収率はほぼ同じ (差 ${diffPct}%)。校正の効果はまだ小さい段階。`);
        }
      }
      if (delta.becamePass === 0 && delta.becameBuy === 0) {
        insight.push("判定が変わったレースはありませんでした(校正の影響が小さい段階)。");
      }
    }

    return {
      total, evaluable,
      original:     { ...orig, recovery: origRec },
      hypothetical: { ...hypo, recovery: hypoRec },
      verdictDelta: delta,
      improvement,
      insight,
    };
  }

  global.Backtest = { run };
})(typeof window !== "undefined" ? window : globalThis);
