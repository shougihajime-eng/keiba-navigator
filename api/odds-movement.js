"use strict";
const { detectMovements } = require("../lib/odds_movement");
const { readLatestRace } = require("../lib/jv_cache");

module.exports = (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const race = readLatestRace();
  if (!race) return res.status(503).json({ ok: false, reason: "レースデータ未取得" });
  const moves = detectMovements(race);
  return res.status(200).json({
    ok: true,
    raceId: race.race_id || race.raceId || null,
    movements: moves,
    threshold: { minDiffPct: 5, largeMovePct: 10 },
    note: "JV-Link接続後・複数回更新で履歴が蓄積され、変動が検出されます。",
  });
};
