"use strict";

// JV-Link 特徴量プロバイダ (現状はスタブ)
// 将来 JV-Link Bridge から取得した過去成績/血統/騎手成績/調教等を horse._jv に付加する責務を負う。
// 接続前は何もしない (race をそのまま返す)。
// 各馬に horse._jv を埋めると heuristic_v1 が自動で重みを反映する。

const fs = require("fs");
const path = require("path");

const CACHE_DIR = path.join(__dirname, "..", "data", "jv_cache");

function loadJvFeatures() {
  // data/jv_cache/features.json があれば読み込む
  // 形式: { "<raceId>": { "<horseNumber>": { jockeyWinRate, courseWinRate, ... } } }
  const p = path.join(CACHE_DIR, "features.json");
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return null; }
}

function augmentWithJvFeatures(race) {
  if (!race || !Array.isArray(race.horses)) return race;
  const all = loadJvFeatures();
  if (!all) return race;

  const raceId = race.race_id || race.raceId;
  const featTable = (raceId && all[raceId]) || all["__default__"] || null;
  if (!featTable) return race;

  return {
    ...race,
    horses: race.horses.map(h => {
      const f = featTable[String(h.number)];
      return f ? { ...h, _jv: { ...(h._jv || {}), ...f } } : h;
    }),
  };
}

module.exports = { augmentWithJvFeatures };
