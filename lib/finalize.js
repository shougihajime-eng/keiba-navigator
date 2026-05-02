"use strict";
// 結果確定ロジック
// JV-Link 接続後に着順データを受け取って、未確定のエア/リアル馬券を finalize する。
//
// 結果データ形式 (data/jv_cache/results/<raceId>.json):
//   {
//     "race_id": "...",
//     "race_name": "...",
//     "finishedAt": "ISO datetime",
//     "results": [
//       { "rank": 1, "number": 6, "name": "...", "tan_payout": 1800 },
//       { "rank": 2, "number": 3, ... }
//     ],
//     "payouts": {            ← オプション(なければ tan_payout から推定)
//       "tan":   { "winner": 6, "amount": 1800 },
//       "fuku":  [{ "number": 6, "amount": 350 }, { "number": 3, "amount": 220 }, { "number": 1, "amount": 150 }],
//       "uren":  { "key": "3-6", "amount": 1290 },
//       "wide":  [{ "key": "3-6", "amount": 410 }, { "key": "1-6", "amount": 380 }, { "key": "1-3", "amount": 240 }],
//       "fuku3": { "key": "1-3-6", "amount": 1830 },
//       "tan3":  { "key": "6-3-1", "amount": 12450 }
//     }
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

// 結果データを受け取って、bet1件を finalize する。
// 返り値: { won, payout, finishedAt, factors } もしくは null (まだ結果なし)
function finalizeBet(bet, result) {
  if (!bet || !result || !Array.isArray(result.results)) return null;
  // 単勝: bet.target は "<number> <name>" 形式。先頭の number で判定
  const targetNum = Number(String(bet.target).split(/\s/)[0]);
  if (!Number.isFinite(targetNum)) return null;

  const finishedAt = result.finishedAt || result.finished_at || new Date().toISOString();
  const winnerEntry = result.results.find(r => r.rank === 1);
  const top3 = result.results.filter(r => r.rank <= 3).map(r => r.number);

  let won = false;
  let payout = 0;
  const factors = [];  // 自動分類タグ

  if (bet.betType === "tan") {
    if (winnerEntry && winnerEntry.number === targetNum) {
      won = true;
      payout = (result.payouts?.tan?.amount) ?? winnerEntry.tan_payout ?? Math.round((bet.odds || 0) * (bet.amount || 100));
    }
  } else if (bet.betType === "fuku") {
    if (top3.includes(targetNum)) {
      won = true;
      const fukuList = result.payouts?.fuku || [];
      const m = fukuList.find(x => x.number === targetNum);
      payout = m?.amount ?? Math.round((bet.odds || 0) * 0.35 * (bet.amount || 100));
    }
  }
  // 馬連・ワイド・三連複・三連単 は bet データに pair/triple 情報が必要(将来対応)

  // 自動勝因/敗因 分類
  const conf = bet.confidence ?? null;
  if (won) {
    if (bet.grade === "S" || bet.grade === "A") factors.push("EVプラス推奨どおり当たり");
    if (bet.popularity != null && bet.popularity >= 6) factors.push("人気薄を見抜いた");
    if (conf != null && conf < 0.20) factors.push("信頼度低でも当たった(運の可能性あり)");
  } else {
    if (winnerEntry) {
      const winRank = bet.popularity || null;
      if (winRank === 1) factors.push("人気馬軽視しすぎ");
      else if (bet.grade === "S") factors.push("EV計算ミス・市場が正しかった");
    }
    factors.push("結果との照合: 着順=" + (result.results.find(r => r.number === targetNum)?.rank ?? "圏外"));
  }

  return {
    won, payout, finishedAt,
    factors,
    spent: bet.amount || 0,
    profit: (won ? payout : 0) - (bet.amount || 0),
  };
}

// 複数のbetを一括finalize: results は raceId をキーとした辞書、
// もしくは undefined で全件 jv_cache/results/ から読む
function finalizeBatch(bets, results = null) {
  const updates = [];
  for (const bet of bets) {
    if (bet.result?.won === true || bet.result?.won === false) continue; // 既に確定
    // raceId が分かれば直接、なければ raceName で探す方法を JV-Link 接続後に拡張
    const raceId = bet.raceId || bet.race_id;
    if (!raceId) continue;
    const result = (results && results[raceId]) || readResult(raceId);
    if (!result) continue;
    const f = finalizeBet(bet, result);
    if (f) updates.push({ id: bet.id, finalize: f });
  }
  return updates;
}

module.exports = { readResult, listResults, finalizeBet, finalizeBatch };
