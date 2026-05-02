"use strict";
// データ接続の単一の真実 (single source of truth)
// JV-Link bridge の状態 + jv_cache 内の実データ有無を厳密に判定する。

const fs = require("fs");
const path = require("path");
const { CACHE_DIR, readJvStatus, listJvCache } = require("./jv_cache");

function isDummyRace(race) {
  if (!race) return false;
  if (race.is_dummy === true) return true;
  if (typeof race.source === "string" && /DUMMY|TEST|テスト|ダミー|SYNTHETIC/i.test(race.source)) return true;
  return false;
}

function ageSeconds(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

function getConnectionStatus() {
  const jv = readJvStatus();
  const jvOk = !!(jv && jv.state === "ready");
  const cacheFiles = listJvCache();

  // races/ ディレクトリ + 実データ判定
  const racesDir = path.join(CACHE_DIR, "races");
  let realRaceCount = 0, dummyRaceCount = 0;
  try {
    const files = fs.readdirSync(racesDir).filter(f => f.endsWith(".json"));
    for (const f of files) {
      try {
        const arr = JSON.parse(fs.readFileSync(path.join(racesDir, f), "utf8"));
        const races = Array.isArray(arr) ? arr : [arr];
        for (const r of races) {
          if (isDummyRace(r)) dummyRaceCount++;
          else realRaceCount++;
        }
      } catch {}
    }
  } catch {}

  // latest_race.json も同様
  try {
    const lr = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, "latest_race.json"), "utf8"));
    if (isDummyRace(lr)) dummyRaceCount++;
    else realRaceCount++;
  } catch {}

  // 結果データ
  const resultsDir = path.join(CACHE_DIR, "results");
  let resultCount = 0;
  try {
    resultCount = fs.readdirSync(resultsDir).filter(f => f.endsWith(".json")).length;
  } catch {}

  // 過去G1データ
  const g1Dir = path.join(CACHE_DIR, "g1_history");
  let g1HistoryCount = 0;
  try {
    g1HistoryCount = fs.readdirSync(g1Dir).filter(f => f.endsWith(".json")).length;
  } catch {}

  return {
    connected: jvOk,
    state: jv?.state || "never_run",
    lastSync: jv?.updatedAt || null,
    ageSec: ageSeconds(jv?.updatedAt),
    cacheFiles: cacheFiles.length,
    realRaceCount,
    dummyRaceCount,
    resultCount,
    g1HistoryCount,
    // 信頼できる予想を出すための条件:
    canTrustPredictions: jvOk && realRaceCount > 0,
    onlyDummyData: realRaceCount === 0 && dummyRaceCount > 0,
    noData: realRaceCount === 0 && dummyRaceCount === 0,
  };
}

module.exports = { getConnectionStatus, isDummyRace };
