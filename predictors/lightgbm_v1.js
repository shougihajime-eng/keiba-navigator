"use strict";
// lightgbm_v1: 学習済み LightGBM モデルの推論結果 (data/jv_cache/predictions/<race_id>.json) を読む predictor。
//
// 設計:
//   - 推論本体は Python (jv_bridge/predict_lightgbm.py) が担当 (LightGBM Windows binary は 32bit COM/64bit ML の事情で
//     ローカル PC でしか動かない)
//   - ローカル PC が 「JV-Link で当日データ取得 → predict_lightgbm.py で推論 → predictions/<id>.json に書く」
//     という流れで朝に走る (自動化レイヤー Wave16 と接続)
//   - 本 module は predictions/ から JSON を読んで、ensemble に与える {horses,confidence} を返す
//
// JSON 不在時は null を返す (ensemble はこれを「データなし」と扱って heuristic に fall back)

const fs = require("node:fs");
const path = require("node:path");

const NAME = "lightgbm_v1";
const VERSION = "1.0.0";

const PREDICTIONS_DIR = path.join(__dirname, "..", "data", "jv_cache", "predictions");
const META_PATH = path.join(__dirname, "..", "data", "jv_cache", "model_lgbm_meta.json");
const BACKTEST_PATH = path.join(__dirname, "..", "data", "jv_cache", "backtest_result.json");

function _readJsonSafe(p) {
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function loadModelMeta() {
  return _readJsonSafe(META_PATH);
}

function loadBacktest() {
  return _readJsonSafe(BACKTEST_PATH);
}

function loadPrediction(raceId) {
  if (!raceId) return null;
  const p = path.join(PREDICTIONS_DIR, `${raceId}.json`);
  return _readJsonSafe(p);
}

function predict(race) {
  const raceId = race?.race_id || race?.raceId;
  const pred = loadPrediction(raceId);
  if (!pred || !pred.ok || !Array.isArray(pred.horses)) {
    return null;
  }
  const horses = pred.horses.map((h) => ({
    number: h.number,
    name:   h.name,
    prob:   Number.isFinite(h.win_prob) ? h.win_prob : 0,
    rawProb: Number.isFinite(h.raw_win_prob) ? h.raw_win_prob : 0,
    rank:   h.rank,
    ev:     Number.isFinite(h.ev) ? h.ev : null,
    odds:   h.odds,
    popularity: h.popularity,
  }));
  return {
    horses,
    confidence: Number.isFinite(pred.confidence) ? pred.confidence : 0,
    modelVersion: pred.model_version || "lgbm_v1",
    modelAuc: Number.isFinite(pred.model_auc) ? pred.model_auc : null,
    modelTrainedAt: pred.model_trained_at || null,
    predictedAt: pred.predicted_at || null,
    source: "lightgbm",
  };
}

module.exports = {
  name: NAME,
  version: VERSION,
  predict,
  loadModelMeta,
  loadBacktest,
  loadPrediction,
};
