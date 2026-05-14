"use strict";

// 馬から特徴量を抽出する関数。
// 現在取得できているフィールド + JV-Link augmentation で付加された _jv 系フィールドを統一インタフェースで返す。
// ⚠ JV-Link接続前は多くの値が null。null は predictor 側で「データなし」として扱う。

function parseAge(sexAge) {
  if (!sexAge) return null;
  const m = String(sexAge).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

function parseSex(sexAge) {
  if (!sexAge) return null;
  const s = String(sexAge);
  if (/牡/.test(s)) return "male";
  if (/牝/.test(s)) return "female";
  if (/セ|騸/.test(s)) return "gelding";
  return null;
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 馬番として有効か (1-30 の整数。30 はサファイヤS等大頭数対応の上限)
function isValidHorseNumber(v) {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n >= 1 && n <= 30;
}

function extractFeatures(horse) {
  return {
    // 現データから直接取れる
    prevFinish:        num(horse.prev_finish),       // 前走着順
    weight:            num(horse.weight),            // 斤量(kg)
    age:               parseAge(horse.sex_age),      // 馬齢
    sex:               parseSex(horse.sex_age),      // 性別
    popularity:        num(horse.popularity),        // 人気(市場)

    // JV-Link augmentation で埋まる予定のフィールド (現状は null)
    jockeyWinRate:     num(horse._jv?.jockeyWinRate),       // 騎手の通算勝率
    courseWinRate:     num(horse._jv?.courseWinRate),       // この競馬場での勝率
    distanceWinRate:   num(horse._jv?.distanceWinRate),     // この距離での勝率
    surfaceWinRate:    num(horse._jv?.surfaceWinRate),      // 芝/ダ別 勝率
    goingWinRate:      num(horse._jv?.goingWinRate),        // 馬場状態別 勝率
    weightChange:      num(horse._jv?.weightChange),        // 馬体重前走比 (+kg)
    daysFromLastRace:  num(horse._jv?.daysFromLastRace),    // 前走からの間隔(日)
    runStyleId:        horse._jv?.runStyleId ?? null,       // 脚質(逃/先/差/追)
    last3F:            num(horse._jv?.last3F),              // 上がり3F平均(秒)
    bestTime:          num(horse._jv?.bestTime),            // 持ち時計
    pedigreeSurfaceAff: num(horse._jv?.pedigreeSurfaceAff), // 血統の芝/ダ適性
    trainingScore:     num(horse._jv?.trainingScore),       // 調教評価
  };
}

// データ完備度: predictor が confidence を計算するときに参照する
function dataCompleteness(features) {
  const fields = [
    "prevFinish", "weight", "age",         // 基本 (現データ)
    "jockeyWinRate", "courseWinRate", "distanceWinRate",  // JV
    "surfaceWinRate", "goingWinRate", "weightChange",     // JV
    "daysFromLastRace", "runStyleId", "last3F",           // JV
    "bestTime", "pedigreeSurfaceAff", "trainingScore",    // JV
  ];
  let present = 0;
  for (const f of fields) if (features[f] !== null) present++;
  return { present, total: fields.length, ratio: present / fields.length };
}

module.exports = { extractFeatures, dataCompleteness, parseAge, parseSex, num, isValidHorseNumber };
