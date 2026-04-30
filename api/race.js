"use strict";
const { readLatestRace } = require("../lib/jv_cache");

module.exports = (req, res) => {
  const race = readLatestRace();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (!race) {
    return res.status(503).json({
      ok: false, status: "unavailable",
      reason: "出走馬データはまだ取得していません。JRA-VAN（有料）の接続設定が完了すると、ここに表示されます。",
    });
  }
  res.status(200).json({ ok: true, race });
};
