"use strict";
// G1 過去10年傾向データの永続化スキーマ
//
// 配置: data/jv_cache/g1_history/<g1_id>.json
// 例: tenno_sho_spring.json, japan_cup.json, arima_kinen.json
//
// 想定スキーマ (JV-Link で集計したあとに書き込む):
// {
//   "g1_id": "tenno_sho_spring",
//   "name": "天皇賞(春)",
//   "course": "京都芝3200",
//   "years_covered": [2015, 2016, ..., 2025],
//   "winners":           [{ year, number, name, popularity, sex_age, jockey, ... }],
//   "top3":              [{ year, top3: [...] }],
//   "blood_trends":      { sire_top: [...], dam_sire_top: [...] },
//   "frame_trends":      { winRateByFrame: {1: 0.10, 2: 0.12, ...} },
//   "leg_style_trends":  { winRateByStyle: { '逃げ': 0.05, '先行': 0.30, '差し': 0.40, '追込': 0.25 } },
//   "popularity_trends": { winRateByPopularity: {1: 0.30, 2: 0.18, ...} },
//   "going_trends":      { winRateByGoing: { '良': 0.40, '稍重': 0.20, '重': 0.10, '不良': 0.30 } },
//   "pace_trends":       { fast: 0.30, even: 0.40, slow: 0.30 },
//   "repeater_winners":  [{ name, years: [2018, 2019] }],
//   "previous_race_trends": { topRace: '阪神大賞典', winRate: 0.40 },
//   "updatedAt": "ISO"
// }

const fs = require("fs");
const path = require("path");
const { CACHE_DIR } = require("./jv_cache");

const G1_DIR = path.join(CACHE_DIR, "g1_history");

function readG1(g1Id) {
  if (!g1Id) return null;
  const p = path.join(G1_DIR, `${g1Id}.json`);
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function listG1() {
  try {
    return fs.readdirSync(G1_DIR).filter(f => f.endsWith(".json")).map(f => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(G1_DIR, f), "utf8"));
        return { g1_id: j.g1_id || f.replace(/\.json$/, ""), name: j.name, yearsCovered: (j.years_covered || []).length, updatedAt: j.updatedAt };
      } catch {
        return { g1_id: f.replace(/\.json$/, ""), name: null, yearsCovered: 0, error: "parse_failed" };
      }
    });
  } catch { return []; }
}

module.exports = { readG1, listG1, G1_DIR };
