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
// 【!】jv_link_features 側のベースライン (jv_bridge/aggregate_features.py) は 0.075 を返す。
//      ここを 0.10 にしておくと「サンプル0の新馬・新人騎手」が中立値からズレて
//      減点される (Bug ⑥相当)。両者を 0.075 で揃え、減点バイアスを消す。
const NEUTRAL = {
  prevFinish: 6,           // 平均的な着順
  weight:     56,          // 標準斤量
  age:        5,           // ピーク中央
  jockeyWinRate:   0.075,
  courseWinRate:   0.075,
  distanceWinRate: 0.075,
  surfaceWinRate:  0.075,
  goingWinRate:    0.075,
  weightChange:    0,
  daysFromLastRace: 28,    // 標準的なローテ
  last3F:          35.5,
  pedigreeSurfaceAff: 0.5,
  trainingScore:   0.5,
};

// 中立値の許容ゼロ距離 (極小サンプル時はベースラインに近いものとして扱う)
const SAMPLE_TRUST_MIN = 5; // 5戦未満は中立扱い

function v(x, neutral) { return x === null ? neutral : x; }

// 極小サンプルなら winRate を中立値に置換 (新馬・新人騎手・転厩などで0%を「悪い」と
// 誤判定する Bug ⑥ の予防)。 jv_link_features は samples が 0 でもベースライン値を返すが、
// 念のためここで二重ガード。
function trustRate(rate, samples, neutral) {
  if (rate === null || rate === undefined) return neutral;
  if (samples === null || samples === undefined) return rate;
  if (samples < SAMPLE_TRUST_MIN) return neutral;
  return rate;
}

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

  // 4. 騎手勝率: 1.0 + 2 * (winRate - baseline)。 新人騎手 (samples < 5) は中立扱い。
  const jwRaw = v(features.jockeyWinRate, NEUTRAL.jockeyWinRate);
  const jw = trustRate(jwRaw, features.jockeySamples, NEUTRAL.jockeyWinRate);
  score *= 1.0 + 2.0 * (jw - NEUTRAL.jockeyWinRate);

  // 5. コース・距離・芝ダ・馬場状態の適性 (それぞれ winRate)
  const cw = v(features.courseWinRate,   NEUTRAL.courseWinRate);
  const dw = v(features.distanceWinRate, NEUTRAL.distanceWinRate);
  const sw = v(features.surfaceWinRate,  NEUTRAL.surfaceWinRate);
  const gw = v(features.goingWinRate,    NEUTRAL.goingWinRate);
  score *= 1.0 + 1.5 * (cw - NEUTRAL.courseWinRate);
  score *= 1.0 + 1.5 * (dw - NEUTRAL.distanceWinRate);
  score *= 1.0 + 1.0 * (sw - NEUTRAL.surfaceWinRate);
  score *= 1.0 + 1.0 * (gw - NEUTRAL.goingWinRate);

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
