"use strict";

/**
 * ensemble_v3 (v4 / 市場アンカー方式):  「勝率計算」を根本から作り直した版。
 *
 * ■ 背景 (2026-06-28 のバグ修正):
 *   旧版は base(ensemble_v1) 0.55 + 自家製LightGBM 0.45 を「足し算」で混ぜていた。
 *   ところが LightGBM の出力が全馬ほぼ一様 (12%前後にベタ塗り＝勝率を当てられていない)
 *   だったため、混ぜると本命の勝率が下がり大穴の勝率が持ち上がり、
 *   期待値 = 勝率 × オッズ が大穴ほど爆発 → 毎レース「500倍の大穴が本命」「EV×19」
 *   という幻の推奨が出ていた。
 *
 * ■ 新しい考え方 (競馬予想の王道):
 *   単勝オッズから逆算した「市場de-vig確率」(= みんなの賭けた結果＝集合知) は
 *   単独で最強クラスの予測。これを“土台(アンカー)”に固定し、
 *   AI(土台ヒューリスティック+DM) は「市場からの上ぶれ・下ぶれ」だけを
 *   控えめに足す。対数空間の幾何ブレンド:
 *       final ∝ market^(1-β) × model^β     (β = モデルのズレを信用する度合い)
 *   β を小さく保つことで確率は市場に近いまま“較正”され、
 *   本当に市場より過小評価されている馬だけが EV>1 になる。
 *   → 幻の大穴+EV が消え、まともな本命・対抗が選ばれる。
 *
 * ■ LightGBM:
 *   現状の model_lgbm は較正不良(ほぼ一様)と実証されたため既定では使わない。
 *   再学習＋確率較正(isotonic等)が済んだら KEIBA_USE_LGBM=1 で小さく復帰可能。
 *
 * 公開 API:
 *   ensemble_v3.predict(race) -> { horses: [{number, prob, ...}], confidence, ... }
 */

const ensemble_v1 = require("./ensemble_v1");
const LgbmEval    = require("./lightgbm_eval");

const NAME = "ensemble_v3";
const VERSION = "4.0.0-market-anchor";

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// 市場de-vig確率: 単勝オッズ 1/odds をレース内で正規化 (overround 除去)
function marketProbsFromRace(race) {
  const horses = race?.horses || [];
  const probs = {};
  let sum = 0;
  for (const h of horses) {
    const o = Number(h.win_odds);
    if (Number.isFinite(o) && o > 1.0) { probs[h.number] = 1 / o; sum += 1 / o; }
  }
  if (sum <= 0) return null;
  for (const k of Object.keys(probs)) probs[k] /= sum;
  return probs;
}

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
  if (!base || !Array.isArray(base.horses)) return base;

  const dmTable   = dmProbsFromRace(race);
  const lgbmTable = LgbmEval.isAvailable() ? LgbmEval.predictRace(race) : null;
  const market    = marketProbsFromRace(race);

  const hasDM     = !!dmTable;
  const hasLgbmRaw = !!lgbmTable && Object.keys(lgbmTable).length > 0;
  // 自家製LightGBMは較正不良(ほぼ一様)と実証 → 既定OFF。再学習・較正後に環境変数で復帰。
  const useLgbm   = hasLgbmRaw && process.env.KEIBA_USE_LGBM === "1";
  const hasMarket = !!market;

  // ── (1) モデル側の混合確率 (土台 + DM [+ 較正後LGBM]) ──────────────
  //   LightGBM を既定で外し、土台ヒューリスティックと公式DM予想だけを足す。
  let wBase, wDM = 0, wLgbm = 0;
  if (hasDM && useLgbm) { wBase = 0.60; wDM = 0.25; wLgbm = 0.15; }
  else if (hasDM)       { wBase = 0.75; wDM = 0.25; }
  else if (useLgbm)     { wBase = 0.85; wLgbm = 0.15; }
  else                  { wBase = 1.00; }

  const modelProb = {};
  let modelSum = 0;
  for (const h of base.horses) {
    const bp = h.prob || 0;
    const dp = (dmTable && dmTable[h.number]) ?? 0;
    const lp = (lgbmTable && lgbmTable[h.number]) ?? 0;
    const p = bp * wBase + dp * wDM + (useLgbm ? lp * wLgbm : 0);
    modelProb[h.number] = p;
    modelSum += p;
  }
  if (modelSum > 0) for (const k of Object.keys(modelProb)) modelProb[k] /= modelSum;

  // ── (2) 市場アンカー × モデルのズレ (対数空間の幾何ブレンド) ────────
  //   final ∝ market^(1-β) × model^β
  //   β = モデルのズレをどれだけ信用するか (小さいほど市場寄り＝堅実)。
  //   市場オッズが無いレースはモデル確率のみで動く (発走前でオッズ未配信など)。
  // ★ "0" は falsy なので `|| 0.25` だと BETA=0 が指定できないバグ → isFinite で判定。
  const _betaEnv = Number(process.env.KEIBA_MODEL_BETA);
  const BETA = clamp(Number.isFinite(_betaEnv) ? _betaEnv : 0.25, 0, 1);

  const out = base.horses.map(h => {
    const m  = hasMarket ? (market[h.number] ?? null) : null;
    const mp = modelProb[h.number] ?? null;
    let prob;
    if (m != null && mp != null) {
      prob = Math.pow(Math.max(m, 1e-9), 1 - BETA) * Math.pow(Math.max(mp, 1e-9), BETA);
    } else if (m != null) {
      prob = m;          // モデル欠損 → 市場のみ
    } else {
      prob = mp ?? 0;    // 市場欠損 → モデルのみ
    }
    return {
      ...h,
      prob,
      market_prob: m,
      model_prob:  mp,
      dm_prob:   (dmTable && dmTable[h.number]) ?? 0,
      lgbm_prob: (lgbmTable && lgbmTable[h.number]) ?? 0,
    };
  });

  // 正規化 (合計 = 1)
  const sum = out.reduce((s, h) => s + (h.prob || 0), 0);
  if (sum > 0) for (const h of out) h.prob = (h.prob || 0) / sum;

  // ── (3) 信頼度 ───────────────────────────────────────────────
  //   旧版はLGBMがあるだけで+12%という“嘘の自信”を出していた。
  //   新版は「市場アンカーが効いている (オッズが入っている)」ことと
  //   「DM予想が手に入っている」ことだけを根拠に控えめにブースト。
  let confBoost = 0;
  if (hasMarket) confBoost += 0.05;
  if (hasDM)     confBoost += 0.05;
  const confidence = Math.min(0.95, (base.confidence ?? 0.5) + confBoost);

  return {
    horses: out,
    confidence,
    predictor: NAME,
    version: VERSION,
    hasMining: hasDM,
    hasMarket,
    hasLightGBM: useLgbm,        // 実際に使ったか (既定OFF)
    lgbmAvailableButOff: hasLgbmRaw && !useLgbm,
    beta: BETA,
    weights: { base: wBase, dm: wDM, lgbm: useLgbm ? wLgbm : 0 },
    modelMeta: LgbmEval.meta(),
  };
}

module.exports = { name: NAME, version: VERSION, predict };
