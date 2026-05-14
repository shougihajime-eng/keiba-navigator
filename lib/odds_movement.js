"use strict";
// オッズ変動の検出
// 各レースの直近オッズスナップショットを保存し、新着 vs 直前で差分を出す。
// 大口投票検出 = 短時間内に大幅にオッズが下がった馬を検出。
//
// 永続化の振る舞い:
//   - ローカル開発: data/jv_cache/odds_history/<raceId>.json (永続)
//   - Vercel 本番:  /tmp/keiba_odds_history/<raceId>.json (best-effort・invocation 間で消える可能性あり)
//     → 本番では「同一ファンクションが温まっている間だけ」差分検出が動く。
//     → 完全な永続化は今後 Supabase 拡張で対応 (db/schema.sql に odds_history テーブル追加予定)。

const fs = require("fs");
const path = require("path");
const { CACHE_DIR } = require("./jv_cache");

// Vercel 本番判定: VERCEL=1 が立っている。本番では /tmp に書く。
const IS_VERCEL = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const HIST_DIR = IS_VERCEL
  ? path.join("/tmp", "keiba_odds_history")
  : path.join(CACHE_DIR, "odds_history");

function readHistory(raceId) {
  if (!raceId) return [];
  try {
    const p = path.join(HIST_DIR, `${raceId}.json`);
    const arr = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function appendSnapshot(raceId, oddsByNumber) {
  if (!raceId || !oddsByNumber) return false;
  try { fs.mkdirSync(HIST_DIR, { recursive: true }); } catch (e) {
    if (!IS_VERCEL) console.warn("[odds_movement] mkdir failed:", e.message);
  }
  const list = readHistory(raceId);
  list.push({ ts: new Date().toISOString(), odds: oddsByNumber });
  // 直近100件のみ保持
  const trimmed = list.slice(-100);
  try {
    fs.writeFileSync(path.join(HIST_DIR, `${raceId}.json`), JSON.stringify(trimmed, null, 2));
    return true;
  } catch (e) {
    // 本番 (Vercel /tmp 外) では writeFile が失敗する。ログだけ出して継続。
    console.warn("[odds_movement] write failed (本番では /tmp に書込・永続化されません):", e.message);
    return false;
  }
}

// race(現在のレースデータ) から最新オッズを取り、直前スナップショットと比較。
// 戻り値: [{ number, prev, curr, diffPct, large: bool }] (差分が ±5% 以上の馬のみ)
function detectMovements(race) {
  if (!race || !Array.isArray(race.horses)) return [];
  const raceId = race.race_id || race.raceId;
  if (!raceId) return [];
  const history = readHistory(raceId);
  if (history.length < 2) {
    // 履歴がないので比較できない → 現在オッズを履歴に追加だけしておく
    const curr = {};
    for (const h of race.horses) if (h.number != null && h.win_odds != null) curr[h.number] = Number(h.win_odds);
    appendSnapshot(raceId, curr);
    return [];
  }
  const prev = history[history.length - 2].odds;
  const curr = history[history.length - 1].odds;
  const moves = [];
  for (const h of race.horses) {
    const n = h.number;
    if (n == null) continue;
    const p = prev[n], c = curr[n];
    if (p == null || c == null) continue;
    const diffPct = ((c - p) / p) * 100;
    if (Math.abs(diffPct) >= 5) {
      moves.push({
        number: n,
        name: h.name || null,
        prev: p, curr: c,
        diffPct: Number(diffPct.toFixed(1)),
        // 大口候補: 5分以内に -10% 以上下がった
        large: diffPct <= -10,
      });
    }
  }
  return moves;
}

module.exports = { readHistory, appendSnapshot, detectMovements, HIST_DIR };
