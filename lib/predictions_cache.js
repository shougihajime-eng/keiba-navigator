"use strict";

/**
 * lib/predictions_cache.js
 *
 * data/jv_cache/predictions.json (pipeline で事前計算された全レース予想) を読む。
 * /api/races と /api/race は最優先でここを参照する → 応答 1ms 以内。
 *
 * 公開 API:
 *   readPredictionsFile()       -> raw JSON or null
 *   readPredictionsMap()        -> { raceId: summary } or null
 *   readPrediction(raceId)      -> summary or null
 *   readLearningStatus()        -> { lgbm, features } or null  (UI で自己学習状況を出す用)
 *   isPredictionsFresh(maxAgeMs) -> bool                      (規定 6 時間)
 */

const fs = require("fs");
const path = require("path");

const FILE_PATH = path.join(__dirname, "..", "data", "jv_cache", "predictions.json");

let _cache = null;
let _cacheMtimeMs = 0;

function _load() {
  try {
    if (!fs.existsSync(FILE_PATH)) {
      _cache = null;
      _cacheMtimeMs = 0;
      return null;
    }
    const stat = fs.statSync(FILE_PATH);
    if (_cache && stat.mtimeMs === _cacheMtimeMs) return _cache;
    const raw = fs.readFileSync(FILE_PATH, "utf-8");
    _cache = JSON.parse(raw);
    _cacheMtimeMs = stat.mtimeMs;
    return _cache;
  } catch (e) {
    // 壊れた予想ファイルでアプリ全停止しないように
    console.warn("[predictions_cache] 読込失敗:", e.message);
    _cache = null;
    return null;
  }
}

function readPredictionsFile() {
  return _load();
}

function readPredictionsMap() {
  const d = _load();
  if (!d || !d.predictions) return null;
  return d.predictions;
}

function readPrediction(raceId) {
  if (!raceId) return null;
  const m = readPredictionsMap();
  if (!m) return null;
  return m[raceId] || null;
}

function readLearningStatus() {
  const d = _load();
  if (!d) return null;
  return d.learning || null;
}

function isPredictionsFresh(maxAgeMs = 6 * 60 * 60 * 1000) {
  const d = _load();
  if (!d || !d.fetchedAt) return false;
  const age = Date.now() - new Date(d.fetchedAt).getTime();
  return age >= 0 && age < maxAgeMs;
}

function predictionsMeta() {
  const d = _load();
  if (!d) return null;
  return {
    schema_version: d.schema_version || 1,
    fetchedAt:      d.fetchedAt || null,
    raceCount:      d.raceCount || 0,
    withHorses:     d.withHorses || 0,
    placeholder:    d.placeholder || 0,
    failed:         d.failed || 0,
    computedMs:     d.computedMs || 0,
  };
}

module.exports = {
  readPredictionsFile,
  readPredictionsMap,
  readPrediction,
  readLearningStatus,
  isPredictionsFresh,
  predictionsMeta,
};
