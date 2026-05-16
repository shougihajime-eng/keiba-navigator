"use strict";

/**
 * ensemble_v3: LightGBM + JRA-VAN マイニング予想 + ensemble_v1 のトリプル混合
 *
 * 構成:
 *   - base   (ensemble_v1 の 6 弱学習器): 信頼性の柱・常時動く
 *   - DM     (JRA-VAN 公式 AI 予想):     dm_jyuni から softmax 化
 *   - LGBM   (自家製 LightGBM):          model_lgbm.json があれば
 *
 *   重み (動的):
 *     - LGBM 有 + DM 有: base 0.45 / DM 0.20 / LGBM 0.35
 *     - LGBM 有 / DM 無: base 0.55 / LGBM 0.45
 *     - LGBM 無 / DM 有: base 0.75 / DM 0.25       (= ensemble_v2 と同じ)
 *     - 両方無:          ensemble_v1 と同等
 *
 *   confidence:
 *     - LGBM 有: +12% ブースト (実データで訓練済モデルがあるので)
 *     - DM 有:   +8% ブースト
 *     - 両方有:  +18% ブースト (上限 0.95)
 *
 * 公開 API:
 *   ensemble_v3.predict(race) -> { horses: [{number, prob, ...}], confidence, ... }
 */

const ensemble_v1 = require("./ensemble_v1");
const LgbmEval    = require("./lightgbm_eval");

const NAME = "ensemble_v3";
const VERSION = "3.0.0";

// DM (JRA-VAN マイニング) probs を horse.dm_jyuni から作る
function dmProbsFromRace(race) {
  const horses = race?.horses || [];
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
  const total = Object.values(probs).reduce((s, p) => s + p, 0);
  if (total <= 0) return null;
  for (const k of Object.keys(probs)) probs[k] = probs[k] / total;
  return probs;
}

function predict(race) {
  const base = ensemble_v1.predict(race);
  const dmTable   = dmProbsFromRace(race);
  const lgbmTable = LgbmEval.isAvailable() ? LgbmEval.predictRace(race) : null;

  const hasDM   = !!dmTable;
  const hasLgbm = !!lgbmTable && Object.keys(lgbmTable).length > 0;

  // ベースのみの場合 (DM, LGBM 両方無し)
  if (!hasDM && !hasLgbm) {
    return { ...base, predictor: NAME, version: VERSION };
  }

  // 重み決定
  let wBase, wDM = 0, wLgbm = 0;
  if (hasLgbm && hasDM) { wBase = 0.45; wDM = 0.20; wLgbm = 0.35; }
  else if (hasLgbm)     { wBase = 0.55; wLgbm = 0.45; }
  else                  { wBase = 0.75; wDM = 0.25; }

  // ブレンド
  const blended = (base.horses || []).map(h => {
    const dmProb   = (dmTable && dmTable[h.number]) ?? 0;
    const lgbmProb = (lgbmTable && lgbmTable[h.number]) ?? 0;
    const baseProb = h.prob || 0;
    const finalProb = baseProb * wBase + dmProb * wDM + lgbmProb * wLgbm;
    return { ...h, prob: finalProb, dm_prob: dmProb, lgbm_prob: lgbmProb };
  });

  // 正規化 (合計 = 1)
  const sum = blended.reduce((s, h) => s + (h.prob || 0), 0);
  if (sum > 0) {
    for (const h of blended) h.prob = h.prob / sum;
  }

  // 信頼度ブースト
  let confBoost = 0;
  if (hasLgbm) confBoost += 0.12;
  if (hasDM)   confBoost += 0.08;
  const confidence = Math.min(0.95, (base.confidence ?? 0.5) + confBoost);

  return {
    horses: blended,
    confidence,
    predictor: NAME,
    version: VERSION,
    hasMining: hasDM,
    hasLightGBM: hasLgbm,
    weights: { base: wBase, dm: wDM, lgbm: wLgbm },
    modelMeta: LgbmEval.meta(),
  };
}

module.exports = { name: NAME, version: VERSION, predict };
