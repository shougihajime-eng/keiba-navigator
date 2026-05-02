"use strict";
const { recommendNextUpdate, PHASE_INTERVAL_SEC } = require("../lib/scheduler");
const { readLatestRace, readAllRaces } = require("../lib/jv_cache");

module.exports = (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  // 直近のレース発走時刻を見て推奨間隔を計算
  const races = readAllRaces();
  let nextStart = null;
  for (const r of races) {
    const s = r.race_start || r.start_time || null;
    if (!s) continue;
    const t = new Date(s).getTime();
    if (isNaN(t)) continue;
    if (!nextStart || t < new Date(nextStart).getTime()) {
      // 過去のものは除外
      if (t > Date.now() - 30 * 60 * 1000) nextStart = s;
    }
  }
  const rec = recommendNextUpdate(nextStart);
  return res.status(200).json({
    ok: true,
    nextRaceStart: nextStart,
    phase: rec.phase,
    intervalSec: rec.intervalSec,
    nextAt: rec.nextAt,
    phasesConfig: PHASE_INTERVAL_SEC,
  });
};
