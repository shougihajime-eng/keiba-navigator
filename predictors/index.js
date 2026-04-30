"use strict";

// Predictor レジストリ。新しいモデルはここに追加するだけ。
// 環境変数 KEIBA_PREDICTOR で切替可能 (デフォルト: heuristic_v1)。

const heuristic_v1 = require("./heuristic_v1");
// const lightgbm_v1 = require("./lightgbm_v1"); // 後で追加

const REGISTRY = {
  heuristic_v1,
  // lightgbm_v1,
};

function getPredictor(name) {
  const key = name || process.env.KEIBA_PREDICTOR || "heuristic_v1";
  return REGISTRY[key] || REGISTRY.heuristic_v1;
}

function listPredictors() {
  return Object.entries(REGISTRY).map(([k, v]) => ({ key: k, name: v.name, version: v.version }));
}

module.exports = { getPredictor, listPredictors };
