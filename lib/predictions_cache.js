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

// 鮮度は 7 日間。predictions.json は再計算しない限り中身は同じなので、
// age が古くても当日レースが含まれていれば有効。当日/翌日フィルタは呼び出し側で。
function isPredictionsFresh(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
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

// 本命の答え合わせログ(直近の決着済みレースで本命が1着/3着内だったか)を読む。
// フロントに渡す用に集計＋直近30件だけに絞る(軽量化)。無ければ null。
const HONMEI_LOG_PATH = path.join(__dirname, "..", "data", "jv_cache", "honmei_log.json");
function readHonmeiLog(recent = 30) {
  try {
    const d = JSON.parse(fs.readFileSync(HONMEI_LOG_PATH, "utf8"));
    if (!d || !Array.isArray(d.entries)) return null;
    return {
      generatedAt: d.generatedAt || null,
      count: d.count || 0,
      winRate: d.winRate ?? null,
      placeRate: d.placeRate ?? null,
      wins: d.wins ?? null,
      places: d.places ?? null,
      entries: d.entries.slice(0, recent),  // 新しい順の直近のみ
    };
  } catch { return null; }
}

module.exports = {
  readPredictionsFile,
  readPredictionsMap,
  readPrediction,
  readLearningStatus,
  isPredictionsFresh,
  predictionsMeta,
  readHonmeiLog,
};
