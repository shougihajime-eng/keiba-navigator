"use strict";

/**
 * predictors/lightgbm_eval.js — LightGBM の JSON ダンプを Node 側で評価する pure-JS インタプリタ
 *
 * 訓練側 (jv_bridge/train_lightgbm.py) が data/jv_cache/model_lgbm.json に
 * dump_model() の結果を吐く。本モジュールはそれを読み込み、決定木を辿って
 * 1 サンプルに対する確率予測を返す。
 *
 * 設計:
 *   - モデルファイル不在時は predict() が null を返す (呼び出し側でフォールバック)
 *   - 起動時に 1 回だけロード・キャッシュ
 *   - 13 次元の特徴量を順序で受け取る (FEATURE_NAMES と一致させる)
 *
 * 公開 API:
 *   LgbmEval.isAvailable() -> bool
 *   LgbmEval.predictProb(featureVec) -> number | null  (1着確率 0..1)
 *   LgbmEval.featureNames() -> string[]
 *   LgbmEval.meta() -> {trained_at, samples_total, metrics, ...}
 */

const fs = require("fs");
const path = require("path");

const MODEL_PATH = path.join(__dirname, "..", "data", "jv_cache", "model_lgbm.json");
const META_PATH  = path.join(__dirname, "..", "data", "jv_cache", "model_lgbm_meta.json");

let _model = null;          // 全 booster 構造
let _meta  = null;          // meta.json 内容
let _featNames = null;
let _loadAttempted = false;

function _tryLoad() {
  if (_loadAttempted) return;
  _loadAttempted = true;
  try {
    if (fs.existsSync(MODEL_PATH)) {
      _model = JSON.parse(fs.readFileSync(MODEL_PATH, "utf8"));
      _featNames = (_model.feature_names || []).slice();
    }
  } catch (e) {
    console.warn("[lightgbm_eval] model load failed:", e.message);
    _model = null;
  }
  try {
    if (fs.existsSync(META_PATH)) {
      _meta = JSON.parse(fs.readFileSync(META_PATH, "utf8"));
      if (!_featNames && _meta.feature_names) _featNames = _meta.feature_names.slice();
    }
  } catch {}
}

function isAvailable() {
  _tryLoad();
  return !!(_model && Array.isArray(_model.tree_info) && _model.tree_info.length > 0);
}

function featureNames() {
  _tryLoad();
  return (_featNames || []).slice();
}

function meta() {
  _tryLoad();
  return _meta || null;
}

// ─── 単一決定木を辿って leaf value を取得 ─────────────────
function _walkTree(node, fv) {
  while (node && node.left_child !== undefined) {
    const featIdx = node.split_feature;
    const v = fv[featIdx];
    const threshold = node.threshold;
    const goLeft = node.default_left
      ? (v === null || v === undefined || Number.isNaN(v) || v <= threshold)
      : (v !== null && v !== undefined && !Number.isNaN(v) && v <= threshold);
    node = goLeft ? node.left_child : node.right_child;
  }
  // leaf
  return node ? (node.leaf_value || 0) : 0;
}

function _sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function predictProb(featureVec) {
  _tryLoad();
  if (!isAvailable()) return null;
  if (!Array.isArray(featureVec)) return null;
  // 各 tree の leaf_value を合計 (binary objective なので logit)
  let sumLogit = 0;
  for (const tree of _model.tree_info) {
    sumLogit += _walkTree(tree.tree_structure, featureVec);
  }
  // sigmoid で確率化
  return _sigmoid(sumLogit);
}

// 馬名/オッズ 等の生 horse オブジェクトと race から特徴ベクトルを組み立てる
// (train_lightgbm.py の extract_horse_features と同じ順序)
function buildFeatureVec(horse, race) {
  const sexAgeNum = (sa) => {
    if (!sa) return -1;
    const d = String(sa).match(/\d+/);
    return d ? Number(d[0]) : -1;
  };
  // 騎手・調教師の rate は features.json から後段で注入される想定。ここでは prior 0.075
  return [
    Number.isFinite(horse.win_odds) ? horse.win_odds : -1,
    Number.isFinite(horse.popularity) ? horse.popularity : -1,
    Number.isFinite(horse.weight) ? horse.weight : -1,
    Number.isFinite(horse.body_weight) ? horse.body_weight : -1,
    Number.isFinite(horse.weight_diff) ? horse.weight_diff : 0,
    sexAgeNum(horse.sex_age),
    Number.isFinite(horse.prev_finish) ? horse.prev_finish : -1,
    Number.isFinite(horse.daysFromLastRace) ? horse.daysFromLastRace : -1,
    Number.isFinite(horse.jockeyWinRate) ? horse.jockeyWinRate : 0.075,
    Number.isFinite(horse.trainerWinRate) ? horse.trainerWinRate : 0.075,
    Number.isFinite(horse.courseWinRate) ? horse.courseWinRate : 0.075,
    Number.isFinite(race.distance) ? race.distance : -1,
    race.is_g1 ? 1.0 : 0.0,
  ];
}

// 1 レース分の馬それぞれに対する LightGBM 予想確率を返す
function predictRace(race) {
  if (!isAvailable() || !race?.horses) return null;
  const probs = {};
  for (const h of race.horses) {
    const fv = buildFeatureVec(h, race);
    const p = predictProb(fv);
    if (p != null) probs[h.number] = p;
  }
  // softmax 正規化 (合計 = 1)
  const sum = Object.values(probs).reduce((s, p) => s + p, 0);
  if (sum > 0) {
    for (const k of Object.keys(probs)) probs[k] = probs[k] / sum;
  }
  return probs;
}

module.exports = {
  name: "lightgbm_eval",
  version: "1.0.0",
  isAvailable,
  featureNames,
  meta,
  predictProb,
  predictRace,
  buildFeatureVec,
};
