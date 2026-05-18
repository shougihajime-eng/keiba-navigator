"use strict";
// ============================================================
// cron_finalize.js
// ------------------------------------------------------------
// Vercel cron (/api/cron-finalize) から呼び出される。
// Supabase keiba.bets テーブルから「result が null かつ
// race_id が JRA 18 桁形式」の bets を全部読み取り、
// 対応する race_results と突合して result/profit/factors を埋める。
// 認証: Vercel が送る Authorization: Bearer ${CRON_SECRET} と一致するときだけ動く。
// ============================================================

const { finalizeBet } = require("./finalize");
const { isFinalizableRaceId } = require("./race_id");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://eqkaaohdbqefuszxwqzr.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || null;

// 一度に処理する bets の上限 (Vercel cron は 60s 制限を意識)
const MAX_BATCH = 500;

async function fetchPendingBets() {
  if (!SUPABASE_KEY) return { ok: false, reason: "SUPABASE_SERVICE_ROLE_KEY 未設定" };
  if (typeof fetch !== "function") return { ok: false, reason: "global fetch not available" };

  // result is null かつ race_id IS NOT NULL かつ created_at が過去 30 日以内
  // 18 桁チェックは JS 側で行う (PostgREST の where 演算子で長さ比較は重い)
  const sinceISO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/bets`
    + `?select=*&result=is.null&race_id=not.is.null`
    + `&created_at=gte.${encodeURIComponent(sinceISO)}`
    + `&order=ts.desc&limit=${MAX_BATCH}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Accept-Profile": "keiba",
    },
  });
  if (!res.ok) {
    return { ok: false, reason: `Supabase ${res.status}: ${await res.text()}` };
  }
  const rows = await res.json();
  // フィールド名を finalize.js の期待形に正規化
  const normalized = (Array.isArray(rows) ? rows : []).map(b => ({
    id: b.id,
    raceId: b.race_id,
    betType: b.bet_type,
    target: b.target,
    combo: null,                       // bets テーブルは combo を持たない (target 文字列パースで対応)
    amount: b.amount,
    odds: b.odds,
    prob: b.prob,
    ev: b.ev,
    grade: b.grade,
    confidence: null,
    popularity: null,
    result: b.result,
    user_id: b.user_id,
  })).filter(b => b.raceId && isFinalizableRaceId(b.raceId));
  return { ok: true, bets: normalized, totalRows: Array.isArray(rows) ? rows.length : 0 };
}

async function fetchResults(raceIds) {
  if (!SUPABASE_KEY) return {};
  if (raceIds.length === 0) return {};
  // PostgREST in.() でまとめて取得
  const inList = raceIds.map(id => `"${id}"`).join(",");
  const url = `${SUPABASE_URL}/rest/v1/race_results`
    + `?select=*&race_id=in.(${encodeURIComponent(inList)})`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Accept-Profile": "keiba",
    },
  });
  if (!res.ok) {
    console.warn("[cron_finalize] race_results fetch failed:", res.status);
    return {};
  }
  const rows = await res.json();
  const map = {};
  for (const row of rows) {
    map[row.race_id] = {
      race_id:    row.race_id,
      race_name:  row.race_name,
      finishedAt: row.finished_at,
      results:    Array.isArray(row.results) ? row.results : [],
      payouts:    row.payouts || {},
    };
  }
  return map;
}

async function updateBet(betId, finalize) {
  const url = `${SUPABASE_URL}/rest/v1/bets?id=eq.${encodeURIComponent(betId)}`;
  const body = {
    result: { won: finalize.won, payout: finalize.payout, finishedAt: finalize.finishedAt },
    factors: finalize.factors,
    profit: finalize.profit,
  };
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Content-Profile": "keiba",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify(body),
  });
  return res.ok;
}

async function runCronFinalize() {
  const started = Date.now();
  const fetched = await fetchPendingBets();
  if (!fetched.ok) {
    return { ok: false, reason: fetched.reason, elapsedMs: Date.now() - started };
  }
  const bets = fetched.bets;
  if (bets.length === 0) {
    return { ok: true, finalized: 0, scanned: 0, elapsedMs: Date.now() - started };
  }
  // 必要な race_id を一括取得
  const raceIds = [...new Set(bets.map(b => b.raceId))];
  const resultMap = await fetchResults(raceIds);

  let finalized = 0;
  let failedUpdates = 0;
  const sampleUpdates = [];
  for (const bet of bets) {
    const result = resultMap[bet.raceId];
    if (!result) continue;
    const f = finalizeBet(bet, result);
    if (!f) continue;
    const ok = await updateBet(bet.id, f);
    if (ok) {
      finalized++;
      if (sampleUpdates.length < 5) sampleUpdates.push({ id: bet.id, won: f.won, payout: f.payout });
    } else {
      failedUpdates++;
    }
  }

  return {
    ok: true,
    scanned: bets.length,
    raceIdsLookedUp: raceIds.length,
    raceResultsFound: Object.keys(resultMap).length,
    finalized,
    failedUpdates,
    sampleUpdates,
    elapsedMs: Date.now() - started,
  };
}

module.exports = { runCronFinalize };
