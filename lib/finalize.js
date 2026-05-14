"use strict";
// 結果確定ロジック
// JV-Link 接続後に着順データを受け取って、未確定のエア/リアル馬券を finalize する。
//
// データソース優先順 (2026-05 〜):
//   1) Supabase keiba.race_results テーブル (本番でも参照可)
//   2) ローカルファイル data/jv_cache/results/<raceId>.json (フォールバック)
//
// 結果データ形式 (両方共通):
//   {
//     "race_id": "...",
//     "race_name": "...",
//     "finished_at" / "finishedAt": "ISO datetime",
//     "results": [
//       { "rank": 1, "number": 6, "name": "...", "tan_payout": 1800 },
//       { "rank": 2, "number": 3, ... }
//     ],
//     "payouts": {
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
const { isFinalizableRaceId } = require("./race_id");

// ─── Supabase 経由の参照 ────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || "https://eqkaaohdbqefuszxwqzr.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || null;

async function readResultFromSupabase(raceId) {
  if (!SUPABASE_KEY || !raceId) return null;
  if (typeof fetch !== "function") {
    console.warn("[finalize] global fetch not available (Node < 18?)");
    return null;
  }
  try {
    const url = `${SUPABASE_URL}/rest/v1/race_results?race_id=eq.${encodeURIComponent(raceId)}&select=*`;
    const res = await fetch(url, {
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Accept-Profile": "keiba",
      },
    });
    if (!res.ok) {
      console.warn(`[finalize] Supabase ${res.status} for race ${raceId}`);
      return null;
    }
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    return {
      race_id:    row.race_id,
      race_name:  row.race_name,
      finishedAt: row.finished_at,
      results:    Array.isArray(row.results) ? row.results : [],
      payouts:    row.payouts || {},
      source:     row.source || "supabase",
    };
  } catch (e) {
    console.warn("[finalize] Supabase fetch failed:", e.message);
    return null;
  }
}

// ─── ファイル経由の参照 (フォールバック) ────────────────────
function readResultFromFile(raceId) {
  if (!raceId) return null;
  const p = path.join(CACHE_DIR, "results", `${raceId}.json`);
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// 同期 API (後方互換・ファイルのみ)
function readResult(raceId) {
  return readResultFromFile(raceId);
}

// 非同期 API: Supabase 優先 → ファイルフォールバック
async function readResultAsync(raceId) {
  const s = await readResultFromSupabase(raceId);
  if (s) return s;
  return readResultFromFile(raceId);
}

function listResults() {
  const dir = path.join(CACHE_DIR, "results");
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
    return files.map(f => ({ raceId: f.replace(/\.json$/, ""), file: f }));
  } catch { return []; }
}

// 馬連/ワイド/3連複 のキー正規化 (順序不問なので昇順ソートして "-" 連結)
function normalizePair(numbers)  { return [...numbers].map(Number).filter(Number.isFinite).sort((a,b)=>a-b).join("-"); }
// 3連単 のキー (順序固定)
function exactKey(numbers)       { return [...numbers].map(Number).filter(Number.isFinite).join("-"); }

// bet.target / bet.combo から馬番リストを取り出す
//   単複 → 先頭の番号 1 つ
//   馬連/ワイド → "3-6" or "3 6" or bet.combo: [3,6]
//   3連複 → "1-3-6"
//   3連単 → "6-3-1"
function extractNumbers(bet) {
  if (Array.isArray(bet?.combo)) return bet.combo.map(Number).filter(Number.isFinite);
  const t = String(bet?.target || "");
  // "<num> <name>" 形式の単複
  const single = t.match(/^\s*(\d{1,2})\b/);
  if ((bet?.betType === "tan" || bet?.betType === "fuku") && single) {
    return [Number(single[1])];
  }
  // "3-6" や "1-3-6" 形式
  const dashes = t.match(/\d+/g);
  return dashes ? dashes.map(Number) : [];
}

// 結果データを受け取って、bet1件を finalize する。
// 返り値: { won, payout, finishedAt, factors } もしくは null (まだ結果なし)
function finalizeBet(bet, result) {
  if (!bet || !result || !Array.isArray(result.results)) return null;
  const finishedAt = result.finishedAt || result.finished_at || new Date().toISOString();
  const winnerEntry = result.results.find(r => r.rank === 1);
  const top3 = result.results.filter(r => r.rank <= 3).map(r => r.number);
  const top3Sorted = [...top3].sort((a,b)=>a-b);
  const exactTop3  = result.results.filter(r => r.rank <= 3).sort((a,b)=>a.rank-b.rank).map(r => r.number);

  const nums = extractNumbers(bet);
  if (nums.length === 0) return null;

  const factors = [];
  let won = false;
  let payout = 0;

  switch (bet.betType) {
    case "tan": {
      const target = nums[0];
      if (winnerEntry && winnerEntry.number === target) {
        won = true;
        payout = (result.payouts?.tan?.amount) ?? winnerEntry.tan_payout
              ?? Math.round((bet.odds || 0) * (bet.amount || 100));
      }
      break;
    }
    case "fuku": {
      const target = nums[0];
      if (top3.includes(target)) {
        won = true;
        const fukuList = result.payouts?.fuku || [];
        const m = fukuList.find(x => x.number === target);
        payout = m?.amount ?? Math.round((bet.odds || 0) * 0.35 * (bet.amount || 100));
      }
      break;
    }
    case "uren":
    case "umaren": {
      if (nums.length >= 2 && exactTop3.length >= 2) {
        const key = normalizePair(nums);
        const winnerKey = normalizePair([exactTop3[0], exactTop3[1]]);
        if (winnerKey && key === winnerKey) {
          won = true;
          payout = (result.payouts?.uren?.amount)
                ?? Math.round((bet.odds || 0) * (bet.amount || 100));
        }
      }
      break;
    }
    case "wide": {
      if (nums.length >= 2) {
        const key = normalizePair(nums);
        const list = result.payouts?.wide || [];
        const m = list.find(x => x.key === key);
        // フォールバック: 上位3頭から 2 頭組合せが全部当たる
        const hitFallback = nums.every(n => top3.includes(n));
        if (m) { won = true; payout = m.amount; }
        else if (hitFallback) {
          won = true;
          payout = Math.round((bet.odds || 0) * (bet.amount || 100));
        }
      }
      break;
    }
    case "fuku3":
    case "sanrenpuku": {
      if (nums.length >= 3 && top3Sorted.length >= 3) {
        const key = normalizePair(nums.slice(0, 3));
        const winnerKey = normalizePair(top3Sorted);
        if (winnerKey && key === winnerKey) {
          won = true;
          payout = (result.payouts?.fuku3?.amount)
                ?? Math.round((bet.odds || 0) * (bet.amount || 100));
        }
      }
      break;
    }
    case "tan3":
    case "sanrentan": {
      if (nums.length >= 3 && exactTop3.length >= 3) {
        const key = exactKey(nums.slice(0, 3));
        const winnerKey = exactKey(exactTop3);
        if (winnerKey && key === winnerKey) {
          won = true;
          payout = (result.payouts?.tan3?.amount)
                ?? Math.round((bet.odds || 0) * (bet.amount || 100));
        }
      }
      break;
    }
    default:
      // unknown bet type → 単勝として処理
      if (winnerEntry && winnerEntry.number === nums[0]) {
        won = true;
        payout = Math.round((bet.odds || 0) * (bet.amount || 100));
      }
  }

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
    factors.push(`結果との照合: 着順=${result.results.find(r => r.number === nums[0])?.rank ?? "圏外"}`);
  }

  return {
    won, payout, finishedAt,
    factors,
    spent: bet.amount || 0,
    profit: (won ? payout : 0) - (bet.amount || 0),
  };
}

// 同期版 finalizeBatch (ファイル参照のみ・後方互換)
function finalizeBatch(bets, results = null) {
  const updates = [];
  for (const bet of bets) {
    if (bet.result?.won === true || bet.result?.won === false) continue;
    const raceId = bet.raceId || bet.race_id;
    if (!raceId || !isFinalizableRaceId(raceId)) continue;  // manual_xxx などはスキップ
    const result = (results && results[raceId]) || readResultFromFile(raceId);
    if (!result) continue;
    const f = finalizeBet(bet, result);
    if (f) updates.push({ id: bet.id, finalize: f });
  }
  return updates;
}

// 非同期版: Supabase 優先で結果取得し、まとめて finalize
async function finalizeBatchAsync(bets) {
  const updates = [];
  // race_id 毎に結果をキャッシュ (重複 race_id を 1 回しか問い合わせない)
  const cache = new Map();
  for (const bet of bets) {
    if (bet.result?.won === true || bet.result?.won === false) continue;
    const raceId = bet.raceId || bet.race_id;
    if (!raceId || !isFinalizableRaceId(raceId)) continue;
    let result;
    if (cache.has(raceId)) {
      result = cache.get(raceId);
    } else {
      result = await readResultAsync(raceId);
      cache.set(raceId, result);
    }
    if (!result) continue;
    const f = finalizeBet(bet, result);
    if (f) updates.push({ id: bet.id, finalize: f });
  }
  return updates;
}

module.exports = {
  readResult, readResultAsync, listResults,
  finalizeBet, finalizeBatch, finalizeBatchAsync,
  // テスト用
  extractNumbers, normalizePair, exactKey,
};
