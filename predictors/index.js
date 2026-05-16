"use strict";

// Predictor レジストリ。新しいモデルはここに追加するだけ。
// 環境変数 KEIBA_PREDICTOR で切替可能 (デフォルト: ensemble_v1)。
// ensemble_v1 は heuristic_v1 + odds-implied + form_curve + pace_fit + pedigree + jockey/trainer の
// 6 弱学習器を加重幾何平均で結合した精度強化版。

const heuristic_v1 = require("./heuristic_v1");
const ensemble_v1  = require("./ensemble_v1");
const ensemble_v2  = require("./ensemble_v2");  // DM (JRA-VAN マイニング予想) を組み込んだ強化版
// const lightgbm_v1 = require("./lightgbm_v1"); // 後で追加

const REGISTRY = {
  heuristic_v1,
  ensemble_v1,
  ensemble_v2,
  // lightgbm_v1,
};

function getPredictor(name) {
  // デフォルトは ensemble_v2 (DM があれば使う・なくても ensemble_v1 と同等動作)
  const key = name || process.env.KEIBA_PREDICTOR || "ensemble_v2";
  return REGISTRY[key] || REGISTRY.ensemble_v2 || REGISTRY.ensemble_v1;
}

function listPredictors() {
  return Object.entries(REGISTRY).map(([k, v]) => ({ key: k, name: v.name, version: v.version }));
}

module.exports = { getPredictor, listPredictors };
