"use strict";
const { readLatestRace } = require("../lib/jv_cache");
const { buildConclusion } = require("../lib/conclusion");

module.exports = (req, res) => {
  const race = readLatestRace();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(buildConclusion(race));
};
