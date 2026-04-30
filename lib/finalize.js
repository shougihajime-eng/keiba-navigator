"use strict";
// 結果確定ロジック スケルトン
// JV-Link 接続後に着順データを受け取って、未確定のエア馬券をクライアント側で finalize する。
// 現状はサーバー側にユーザーの bet 履歴がない(localStorage のみ)ため、
// このAPIは「特定レースの結果データ」を返すだけ。クライアントが照合する。
//
// データ形式想定 (data/jv_cache/results/<raceId>.json):
//   {
//     "race_id": "...",
//     "race_name": "...",
//     "finishedAt": "ISO datetime",
//     "results": [{ "rank": 1, "number": 6, "name": "...", "tan_payout": 1800 },
//                 { "rank": 2, "number": 3, ... }, ...]
//   }

const fs = require("fs");
const path = require("path");
const { CACHE_DIR } = require("./jv_cache");

function readResult(raceId) {
  if (!raceId) return null;
  const p = path.join(CACHE_DIR, "results", `${raceId}.json`);
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function listResults() {
  const dir = path.join(CACHE_DIR, "results");
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
    return files.map(f => ({ raceId: f.replace(/\.json$/, ""), file: f }));
  } catch { return []; }
}

module.exports = { readResult, listResults };
