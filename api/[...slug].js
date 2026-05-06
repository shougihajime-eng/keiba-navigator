"use strict";
// Vercel Hobby プランの「12 Serverless Functions まで」制限を回避するため、
// 全 API を 1 つの Catch-all Route で集約。/api/foo は slug=['foo'] で届く。
// ロジックは lib/* に集約済みなので、ここでは routing のみ。

const url_mod = require("url");

const { buildStatus }       = require("../lib/status");
const { fetchAllWeather }   = require("../lib/weather");
const { fetchNews }         = require("../lib/news");
const { readLatestRace, readAllRaces } = require("../lib/jv_cache");
const { buildConclusion }   = require("../lib/conclusion");
const { loadVenues }        = require("../lib/venues");
const { clearCache }        = require("../lib/fetch");

function ok(res, body)  { res.setHeader("Cache-Control", "no-store"); res.status(200).json(body); }
function bad(res, code, body) { res.setHeader("Cache-Control", "no-store"); res.status(code).json(body); }

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // Vercel は req.query.slug に [foo, bar] のように配列を渡す
  let slug = req.query?.slug;
  if (Array.isArray(slug)) slug = slug.join("/");
  // フォールバック: req.url から取り出し
  if (!slug && req.url) {
    const p = url_mod.parse(req.url, true).pathname || "";
    slug = p.replace(/^\/api\/?/, "");
  }
  const path = "/" + (slug || "");

  try {
    if (path === "/status")     return ok(res, buildStatus());
    if (path === "/weather")    return ok(res, await fetchAllWeather());
    if (path === "/news") {
      const data = await fetchNews();
      return data.ok ? ok(res, data) : bad(res, 502, data);
    }
    if (path === "/race") {
      const race = readLatestRace();
      if (!race) return bad(res, 503, {
        ok: false, status: "unavailable",
        reason: "出走馬データはまだ取得していません。JRA-VAN（有料）の接続設定が完了すると、ここに表示されます。",
      });
      return ok(res, { ok: true, race });
    }
    if (path === "/conclusion") return ok(res, buildConclusion(readLatestRace()));
    if (path === "/conclusion-manual" && req.method === "POST") {
      const { buildManualConclusion } = require("../lib/manual_race");
      const payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      return ok(res, buildManualConclusion(payload));
    }
    if (path === "/races") {
      const races = readAllRaces();
      if (!races.length) {
        return bad(res, 503, {
          ok: false, status: "unavailable", races: [],
          reason: "出走馬データはまだ取得していません。JRA-VAN（有料）の接続設定後に表示されます。",
        });
      }
      const summaries = races.map(race => {
        const c = buildConclusion(race);
        return {
          raceName: race.race_name || null,
          raceId:   race.race_id   || null,
          course:   race.course    || null,
          venue:    race.venue     || null,
          isDummy:  !!race.is_dummy || /DUMMY|TEST|テスト|ダミー|SYNTHETIC/i.test(race.source || ""),
          verdict:  c.verdict,
          topGrade: c.topGrade,
          topPick: c.picks?.[0] ? { number: c.picks[0].number, name: c.picks[0].name, odds: c.picks[0].odds, ev: c.picks[0].ev, grade: c.picks[0].grade } : null,
          confidence: c.confidence,
          hasOverpop:  (c.overpopular || []).length > 0,
          hasUnderval: (c.undervalued || []).length > 0,
        };
      });
      return ok(res, { ok: true, fetchedAt: new Date().toISOString(), raceCount: summaries.length, races: summaries });
    }
    if (path === "/refresh") { clearCache(); return ok(res, { ok: true }); }
    if (path === "/venues") return ok(res, { ok: true, venues: loadVenues() });
    if (path === "/connection") {
      const { getConnectionStatus } = require("../lib/connection_status");
      return ok(res, getConnectionStatus());
    }
    if (path === "/result") {
      const { readResult, listResults } = require("../lib/finalize");
      const raceId = req.query?.raceId;
      if (raceId) {
        const r = readResult(raceId);
        if (!r) return bad(res, 404, { ok: false, reason: "結果データなし(JV-Link接続後に取得)" });
        return ok(res, { ok: true, result: r });
      }
      return ok(res, { ok: true, available: listResults() });
    }
    if (path === "/finalize" && req.method === "POST") {
      const { finalizeBatch } = require("../lib/finalize");
      const payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const bets = Array.isArray(payload.bets) ? payload.bets : [];
      const updates = finalizeBatch(bets);
      return ok(res, { ok: true, count: updates.length, updates });
    }
    if (path === "/g1-history") {
      const { readG1, listG1 } = require("../lib/g1_history");
      const id = req.query?.id;
      if (id) {
        const r = readG1(id);
        if (!r) return bad(res, 404, { ok: false, reason: "G1履歴データなし(JV-Link接続後に集計)" });
        return ok(res, { ok: true, history: r });
      }
      return ok(res, { ok: true, available: listG1() });
    }
    if (path === "/odds-movement") {
      const { detectMovements } = require("../lib/odds_movement");
      const race = readLatestRace();
      if (!race) return bad(res, 503, { ok: false, reason: "レースデータ未取得" });
      const moves = detectMovements(race);
      return ok(res, {
        ok: true,
        raceId: race.race_id || race.raceId || null,
        movements: moves,
        threshold: { minDiffPct: 5, largeMovePct: 10 },
        note: "JV-Link接続後・複数回更新で履歴が蓄積され、変動が検出されます。",
      });
    }
    if (path === "/schedule") {
      const { recommendNextUpdate, PHASE_INTERVAL_SEC } = require("../lib/scheduler");
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
      return ok(res, {
        ok: true,
        nextRaceStart: nextStart,
        phase: rec.phase, intervalSec: rec.intervalSec, nextAt: rec.nextAt,
        phasesConfig: PHASE_INTERVAL_SEC,
      });
    }

    return bad(res, 404, { ok: false, error: "Unknown API path: " + path });
  } catch (e) {
    return bad(res, 500, { ok: false, error: String(e?.message || e) });
  }
};
