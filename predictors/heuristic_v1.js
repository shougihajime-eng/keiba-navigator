"use strict";

// heuristic_v1: 学習なしの単純ヒューリスティック推定勝率モジュール
//
// 設計思想:
//   - オッズを「使わない」（オッズに引きずられたら期待値判定にならない）
//   - 取得できている特徴量だけを使い、欠損は中立値で埋める
//   - 出力: 各馬の推定勝率(合計1.0) + 信頼度(0..1)
//   - 後で LightGBM 等の学習モデルに差し替えられるよう、関数1つで完結する
//
// 使う特徴量(現データで取れるもの):
//   prevFinish (前走着順) ─ メイン信号
//   weight (斤量) ─ 軽補正
//   age (馬齢) ─ 軽補正
//
// JV-Link 接続後に効く特徴量(取得できれば自動で重みに反映される):
//   jockeyWinRate, courseWinRate, distanceWinRate, surfaceWinRate,
//   goingWinRate, weightChange, daysFromLastRace, last3F,
//   pedigreeSurfaceAff, trainingScore

const { extractFeatures, dataCompleteness } = require("./features");

const NAME = "heuristic_v1";
const VERSION = "0.1.0";

// 各特徴量の中立値 (欠損時に使う)。中立値=スコアに影響しない値
const NEUTRAL = {
  prevFinish: 6,           // 平均的な着順
  weight:     56,          // 標準斤量
  age:        5,           // ピーク中央
  jockeyWinRate:   0.10,
  courseWinRate:   0.10,
  distanceWinRate: 0.10,
  surfaceWinRate:  0.10,
  goingWinRate:    0.10,
  weightChange:    0,
  daysFromLastRace: 28,    // 標準的なローテ
  last3F:          35.5,
  pedigreeSurfaceAff: 0.5,
  trainingScore:   0.5,
};

function v(x, neutral) { return x === null ? neutral : x; }

function scoreHorse(features) {
  // 1. 前走着順を主信号に。1着→1.0, 5着→0.135, 10着→0.018
  const prev = v(features.prevFinish, NEUTRAL.prevFinish);
  let score = Math.exp(-0.4 * (prev - 1));

  // 2. 斤量補正: 標準56kg、+1kgで-2.5%
  const weight = v(features.weight, NEUTRAL.weight);
  score *= Math.max(0.7, 1 - 0.025 * (weight - 56));

  // 3. 馬齢補正: 4-6歳ピーク
  const age = v(features.age, NEUTRAL.age);
  if (age >= 4 && age <= 6) score *= 1.0;
  else if (age === 3 || age === 7) score *= 0.92;
  else score *= 0.85;

  // ─── JV-Link接続後に効く補正 (現状はNEUTRAL=中立で無効化されている) ───

  // 4. 騎手勝率: 1.0 + 2 * (winRate - baseline)
  const jw = v(features.jockeyWinRate, NEUTRAL.jockeyWinRate);
  score *= 1.0 + 2.0 * (jw - 0.10);

  // 5. コース・距離・芝ダ・馬場状態の適性 (それぞれ winRate)
  const cw = v(features.courseWinRate,   NEUTRAL.courseWinRate);
  const dw = v(features.distanceWinRate, NEUTRAL.distanceWinRate);
  const sw = v(features.surfaceWinRate,  NEUTRAL.surfaceWinRate);
  const gw = v(features.goingWinRate,    NEUTRAL.goingWinRate);
  score *= 1.0 + 1.5 * (cw - 0.10);
  score *= 1.0 + 1.5 * (dw - 0.10);
  score *= 1.0 + 1.0 * (sw - 0.10);
  score *= 1.0 + 1.0 * (gw - 0.10);

  // 6. 馬体重増減: ±10kg超は減点
  const wch = v(features.weightChange, NEUTRAL.weightChange);
  const wchAbs = Math.abs(wch);
  if (wchAbs > 10) score *= 0.85;
  else if (wchAbs > 6) score *= 0.93;

  // 7. 休み明け補正: 90日以上空くと-10%
  const days = v(features.daysFromLastRace, NEUTRAL.daysFromLastRace);
  if (days > 90) score *= 0.90;
  else if (days < 7) score *= 0.95;

  // 8. 上がり3F: 速いほど高評価 (中立 35.5 秒)。
  //   式: 1.0 + 0.05 * (35.5 - f3) → f3 が 35.5 より小さい (速い) ほど +、大きい (遅い) ほど -
  //   例: f3=34.5 (速) → 1.05、f3=36.5 (遅) → 0.95
  //   スコア下限は scoreHorse 末尾の Math.max(score, 1e-6) で保護される
  const f3 = v(features.last3F, NEUTRAL.last3F);
  score *= 1.0 + 0.05 * (NEUTRAL.last3F - f3);

  // 9. 血統の芝/ダ適性 (0..1)
  const ped = v(features.pedigreeSurfaceAff, NEUTRAL.pedigreeSurfaceAff);
  score *= 0.85 + 0.30 * ped;

  // 10. 調教評価 (0..1)
  const tr = v(features.trainingScore, NEUTRAL.trainingScore);
  score *= 0.85 + 0.30 * tr;

  return Math.max(score, 1e-6);
}

function predict(race) {
  if (!race || !Array.isArray(race.horses) || race.horses.length === 0) {
    return null;
  }

  const featuresList = race.horses.map(h => ({ horse: h, features: extractFeatures(h) }));
  const scores = featuresList.map(({ horse, features }) => ({
    number: horse.number,
    name: horse.name || null,
    score: scoreHorse(features),
    completeness: dataCompleteness(features),
  }));

  const total = scores.reduce((a, b) => a + b.score, 0);
  if (total <= 0) return null;

  const horses = scores.map(s => ({
    number: s.number,
    name: s.name,
    prob: s.score / total,
    rawScore: s.score,
  }));

  // 信頼度: データ完備度と馬数で算出。stub なので 0.45 でキャップ。
  const avgCompleteness = scores.reduce((a, b) => a + b.completeness.ratio, 0) / scores.length;
  // ヒューリスティックは原理的に信頼度上限が低い
  const baseConfidence = avgCompleteness * 0.6;
  const sizeAdj = Math.min(1, race.horses.length / 8);
  const confidence = Math.min(0.45, baseConfidence * sizeAdj);

  return {
    name: NAME,
    version: VERSION,
    confidence,
    completeness: {
      perHorseAvgRatio: avgCompleteness,
      featureCount: scores[0]?.completeness.total ?? 0,
    },
    horses,
  };
}

module.exports = { name: NAME, version: VERSION, predict };
