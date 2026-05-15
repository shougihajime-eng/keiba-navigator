"use strict";
// ローカル開発用サーバー (Vercel ではこのファイルは使われず、api/*.js が使われる)
// 本番のapi/*.jsとロジックを共有するため、すべて lib/ を経由する。

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8765);

// WHATWG URL API でリクエスト URL をパースする (url.parse() は deprecated)
function parseReqUrl(req) {
  const u = new URL(req.url || "/", "http://127.0.0.1");
  // query を Object に変換 (互換: u.query?.foo の使い方を保てるように)
  const query = {};
  for (const [k, v] of u.searchParams.entries()) query[k] = v;
  return { pathname: u.pathname, query };
}

const { buildStatus }     = require("./lib/status");
const { fetchAllWeather } = require("./lib/weather");
const { fetchNews }       = require("./lib/news");
const { readLatestRace, readAllRaces } = require("./lib/jv_cache");
const { buildConclusion } = require("./lib/conclusion");
const { loadVenues }      = require("./lib/venues");
const { clearCache }      = require("./lib/fetch");

function jsonRes(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

async function serve(req, res) {
  try {
    const u = parseReqUrl(req);
    const p = u.pathname || "/";

    if (p === "/api/status") {
      return jsonRes(res, 200, buildStatus());
    }
    if (p === "/api/weather") {
      return jsonRes(res, 200, await fetchAllWeather());
    }
    if (p === "/api/news") {
      const data = await fetchNews();
      return jsonRes(res, data.ok ? 200 : 502, data);
    }
    if (p === "/api/race") {
      const race = readLatestRace();
      if (!race) return jsonRes(res, 503, {
        ok: false, status: "unavailable",
        reason: "出走馬データはまだ取得していません。JRA-VAN（有料）の接続設定が完了すると、ここに表示されます。",
      });
      return jsonRes(res, 200, { ok: true, race });
    }
    if (p === "/api/conclusion") {
      return jsonRes(res, 200, buildConclusion(readLatestRace()));
    }
    if (p === "/api/conclusion-manual") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Allow": "POST" });
        return res.end(JSON.stringify({ ok: false, error: "Method Not Allowed. Allow: POST" }));
      }
      const { buildManualConclusion } = require("./lib/manual_race");
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const payload = body ? JSON.parse(body) : {};
        return jsonRes(res, 200, buildManualConclusion(payload));
      } catch (e) {
        return jsonRes(res, 400, { ok: false, error: String(e.message || e) });
      }
    }
    if (p === "/api/races") {
      const races = readAllRaces();
      if (!races.length) {
        return jsonRes(res, 503, {
          ok: false, status: "unavailable", races: [],
          reason: "出走馬データはまだ取得していません。JRA-VAN（有料）の接続設定後に表示されます。",
        });
      }
      const summaries = races.map(race => {
        const c = buildConclusion(race);
        return {
          raceName: race.race_name || null,
          raceId: race.race_id || null,
          course: race.course || null,
          venue: race.venue || null,
          surface: race.surface || null,
          distance: race.distance || null,
          startTime: race.race_start || race.start_time || null,
          isDummy: !!race.is_dummy || /DUMMY|TEST|テスト|ダミー|SYNTHETIC/i.test(race.source || ""),
          isG1: c.raceMeta?.isG1 || false,
          verdict: c.verdict,
          verdictTitle: c.verdictTitle,
          topGrade: c.topGrade,
          topPick: c.picks?.[0] ? { number: c.picks[0].number, name: c.picks[0].name, odds: c.picks[0].odds, ev: c.picks[0].ev, grade: c.picks[0].grade, prob: c.picks[0].prob } : null,
          second: c.picks?.[1] ? { number: c.picks[1].number, name: c.picks[1].name, odds: c.picks[1].odds, ev: c.picks[1].ev, grade: c.picks[1].grade } : null,
          third: c.picks?.[2] ? { number: c.picks[2].number, name: c.picks[2].name, odds: c.picks[2].odds, ev: c.picks[2].ev, grade: c.picks[2].grade } : null,
          confidence: c.confidence,
          hasOverpop: (c.overpopular || []).length > 0,
          hasUnderval: (c.undervalued || []).length > 0,
          trackBiasNote: c.raceMeta?.trackBiasNote || null,
          horseCount: Array.isArray(race.horses) ? race.horses.length : 0,
        };
      });
      summaries.sort((a, b) => {
        if (a.startTime && b.startTime) return a.startTime.localeCompare(b.startTime);
        return String(a.raceId || "").localeCompare(String(b.raceId || ""));
      });
      return jsonRes(res, 200, { ok: true, fetchedAt: new Date().toISOString(), raceCount: summaries.length, races: summaries });
    }
    if (p === "/api/win5") {
      const { buildWin5, formatWin5 } = require("./lib/win5_engine");
      const races = readAllRaces();
      if (!races.length) return jsonRes(res, 503, { ok: false, reason: "出走馬データ未取得" });
      const sundayRaces = races.filter(r => {
        const t = r.race_start || r.start_time;
        if (!t) return false;
        return new Date(t).getDay() === 0;
      });
      const candidates = (sundayRaces.length >= 5 ? sundayRaces : races).slice(0, 5);
      const win5 = buildWin5(candidates);
      return jsonRes(res, 200, { ok: true, ...formatWin5(win5), candidateRaceIds: candidates.map(r => r.race_id || null) });
    }
    if (p === "/api/news-annotated") {
      const { annotateRaceWithNews } = require("./lib/news_sentiment");
      const newsData = await fetchNews();
      const race = readLatestRace();
      if (!race) return jsonRes(res, 503, { ok: false, reason: "レースデータ未取得" });
      const annotated = annotateRaceWithNews(race, newsData?.items || []);
      return jsonRes(res, 200, {
        ok: true,
        raceId: race.race_id || null,
        annotated,
        newsCount: (newsData?.items || []).length,
      });
    }
    if (p === "/api/refresh") {
      clearCache();
      return jsonRes(res, 200, { ok: true });
    }
    if (p === "/api/venues") {
      return jsonRes(res, 200, { ok: true, venues: loadVenues() });
    }
    if (p === "/api/connection") {
      const { getConnectionStatus } = require("./lib/connection_status");
      return jsonRes(res, 200, getConnectionStatus());
    }
    if (p === "/api/result") {
      // 本番と同じく async 版を使用 (Supabase 優先 → ファイルフォールバック)
      const { readResultAsync, listResults } = require("./lib/finalize");
      const raceId = u.query?.raceId;
      if (raceId) {
        const r = await readResultAsync(raceId);
        if (!r) return jsonRes(res, 404, { ok: false, reason: "結果データなし(JV-Link接続後に取得)" });
        return jsonRes(res, 200, { ok: true, result: r });
      }
      return jsonRes(res, 200, { ok: true, available: listResults() });
    }
    if (p === "/api/finalize") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Allow": "POST" });
        return res.end(JSON.stringify({ ok: false, error: "Method Not Allowed. Allow: POST" }));
      }
      const { finalizeBatchAsync } = require("./lib/finalize");
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const payload = body ? JSON.parse(body) : {};
        const bets = Array.isArray(payload.bets) ? payload.bets : [];
        const updates = await finalizeBatchAsync(bets);
        return jsonRes(res, 200, { ok: true, count: updates.length, updates });
      } catch (e) {
        return jsonRes(res, 400, { ok: false, error: String(e.message || e) });
      }
    }
    if (p === "/api/g1-history") {
      const { readG1, listG1 } = require("./lib/g1_history");
      const id = u.query?.id;
      if (id) {
        const r = readG1(id);
        if (!r) return jsonRes(res, 404, { ok: false, reason: "G1履歴データなし(JV-Link接続後に集計)" });
        return jsonRes(res, 200, { ok: true, history: r });
      }
      return jsonRes(res, 200, { ok: true, available: listG1() });
    }
    if (p === "/api/odds-movement") {
      const { detectMovements } = require("./lib/odds_movement");
      const race = readLatestRace();
      if (!race) return jsonRes(res, 503, { ok: false, reason: "レースデータ未取得" });
      const moves = detectMovements(race);
      return jsonRes(res, 200, {
        ok: true,
        raceId: race.race_id || race.raceId || null,
        movements: moves,
        threshold: { minDiffPct: 5, largeMovePct: 10 },
        note: "JV-Link接続後・複数回更新で履歴が蓄積され、変動が検出されます。",
      });
    }
    if (p === "/api/schedule") {
      const { recommendNextUpdate, PHASE_INTERVAL_SEC } = require("./lib/scheduler");
      const races = readAllRaces();
      let nextStart = null;
      for (const r of races) {
        const s = r.race_start || r.start_time || null;
        if (!s) continue;
        const t = new Date(s).getTime();
        if (isNaN(t)) continue;
        if (t > Date.now() - 30 * 60 * 1000 && (!nextStart || t < new Date(nextStart).getTime())) {
          nextStart = s;
        }
      }
      const rec = recommendNextUpdate(nextStart);
      return jsonRes(res, 200, {
        ok: true,
        nextRaceStart: nextStart,
        phase: rec.phase,
        intervalSec: rec.intervalSec,
        nextAt: rec.nextAt,
        phasesConfig: PHASE_INTERVAL_SEC,
      });
    }

    // 静的ファイル
    let filePath = path.join(ROOT, decodeURIComponent(p));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end("Forbidden"); }
    let stat = null;
    try { stat = fs.statSync(filePath); } catch {}
    if (stat && stat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      try { stat = fs.statSync(filePath); } catch { stat = null; }
    }
    if (!stat) { res.writeHead(404); return res.end("Not Found"); }

    const ext = path.extname(filePath).toLowerCase();
    const mime = {
      ".html": "text/html; charset=utf-8",
      ".js":   "application/javascript; charset=utf-8",
      ".css":  "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg":  "image/svg+xml",
      ".png":  "image/png",
      ".ico":  "image/x-icon",
      ".txt":  "text/plain; charset=utf-8",
    }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    try { jsonRes(res, 500, { ok: false, error: String(e.message || e) }); } catch {}
  }
}

http.createServer(serve).listen(PORT, "127.0.0.1", () => {
  console.log(`🏇 KEIBA NAVIGATOR (local) on http://127.0.0.1:${PORT}`);
});
