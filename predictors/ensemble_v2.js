"use strict";

/**
 * ensemble_v2: JRA-VAN マイニング予想 (DM) を組み込んだ強化版アンサンブル
 *
 * 設計思想:
 *   ensemble_v1 の 6 弱学習器 + JRA-VAN 公式 AI (DM 予想) を加重平均する。
 *   DM 予想は dm_jyuni (予想順位) を 0..1 prob 化して 7 番目の弱学習器とする。
 *   DM があるレースでは DM 重みを大きく (信頼性高い)、無ければ ensemble_v1 と同等動作。
 *
 *   重み:
 *     - DM 有: base(0.20) + odds(0.25) + form(0.15) + pace(0.05) + ped(0.05) + jt(0.05) + DM(0.25)
 *     - DM 無: ensemble_v1 と同じ重み (DM を 0 として除算)
 *
 * 公開 API:
 *   ensemble_v2.predict(race) -> { horses: [{number, prob, ...}], confidence }
 */

const heuristic_v1 = require("./heuristic_v1");
const ensemble_v1  = require("./ensemble_v1");

const NAME = "ensemble_v2";
const VERSION = "2.0.0";

// DM 予想 → 馬番ごとの "DM-derived prob" を作る
// dm_jyuni: 1=最有力, 2=2番手, ... なので 1 / dm_jyuni をベースに softmax 化
function dmProbsFromRace(race) {
  const horses = race?.horses || [];
  const dmRows = race?.dm_predictions;
  if (!Array.isArray(dmRows) || !dmRows.length) return null;
  // dm_predictions に dm_jyuni が無い (header のみの場合) 場合、horse SE.dm_jyuni を見る
  const probs = {};
  let any = false;
  for (const h of horses) {
    const j = h.dm_jyuni ?? h.miningJyuni;
    if (Number.isFinite(j) && j >= 1) {
      probs[h.number] = 1 / j;
      any = true;
    }
  }
  if (!any) return null;
  // softmax normalization
  const total = Object.values(probs).reduce((s, p) => s + p, 0);
  if (total <= 0) return null;
  for (const k of Object.keys(probs)) probs[k] = probs[k] / total;
  return probs;
}

function predict(race) {
  // ベースは ensemble_v1
  const base = ensemble_v1.predict(race);
  const dmTable = dmProbsFromRace(race);
  if (!dmTable) {
    // DM 無し → そのまま ensemble_v1 の結果を返す
    return { ...base, predictor: NAME, version: VERSION };
  }

  // DM 有 → DM 重み 0.25 でブレンド
  const dmWeight = 0.25;
  const baseWeight = 0.75;
  const blended = (base.horses || []).map(h => {
    const dm = dmTable[h.number] ?? 0;
    const blendedProb = h.prob * baseWeight + dm * dmWeight;
    return { ...h, prob: blendedProb, dm_prob: dm };
  });

  // 正規化 (合計 = 1)
  const sum = blended.reduce((s, h) => s + (h.prob || 0), 0);
  if (sum > 0) {
    for (const h of blended) h.prob = h.prob / sum;
  }

  // 信頼度は base + DM ブースト
  const confidence = Math.min(1, (base.confidence ?? 0.5) + 0.08);

  return {
    horses: blended,
    confidence,
    predictor: NAME,
    version: VERSION,
    hasMining: true,
    dmWeight,
  };
}

module.exports = { name: NAME, version: VERSION, predict };
