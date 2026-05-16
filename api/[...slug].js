"use strict";
// Vercel Hobby プランの「12 Serverless Functions まで」制限を回避するため、
// 全 API を 1 つの Catch-all Route で集約。/api/foo は slug=['foo'] で届く。
// ロジックは lib/* に集約済みなので、ここでは routing のみ。

const { buildStatus }       = require("../lib/status");
const { fetchAllWeather }   = require("../lib/weather");
const { fetchNews }         = require("../lib/news");
const { readLatestRace, readAllRaces } = require("../lib/jv_cache");
const { buildConclusion }   = require("../lib/conclusion");
const { loadVenues }        = require("../lib/venues");
const { clearCache }        = require("../lib/fetch");

function ok(res, body)  { res.setHeader("Cache-Control", "no-store"); res.status(200).json(body); }
function bad(res, code, body) { res.setHeader("Cache-Control", "no-store"); res.status(code).json(body); }
function methodNotAllowed(res, allow) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Allow", allow);
  res.status(405).json({ ok: false, error: `Method Not Allowed. Allow: ${allow}` });
}
// `?key=a&key=b` の二重指定攻撃を防ぐ。配列が来たら 1 件目だけ採用
function firstQuery(v) { return Array.isArray(v) ? v[0] : v; }

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // CORS: 単一オリジン PWA 想定だが、本番デプロイで Workbox / 別ホストからの試行に備えて GET を許可
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.status(204).end();
    return;
  }

  // Vercel は req.query.slug に [foo, bar] のように配列を渡す
  let slug = req.query?.slug;
  if (Array.isArray(slug)) slug = slug.join("/");
  // フォールバック: req.url から取り出し (WHATWG URL API)
  if (!slug && req.url) {
    const u = new URL(req.url, "http://localhost");
    slug = (u.pathname || "").replace(/^\/api\/?/, "");
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
    if (path === "/conclusion-manual") {
      if (req.method !== "POST") return methodNotAllowed(res, "POST");
      const { buildManualConclusion } = require("../lib/manual_race");
      let payload;
      try {
        payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      } catch (e) {
        return bad(res, 400, { ok: false, error: "リクエスト本文の JSON が不正です: " + (e?.message || e) });
      }
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
          surface:  race.surface   || null,
          distance: race.distance  || null,
          startTime: race.race_start || race.start_time || null,
          isDummy:  !!race.is_dummy || /DUMMY|TEST|テスト|ダミー|SYNTHETIC/i.test(race.source || ""),
          isG1:     c.raceMeta?.isG1 || false,
          verdict:  c.verdict,
          verdictTitle: c.verdictTitle,
          topGrade: c.topGrade,
          topPick: c.picks?.[0] ? { number: c.picks[0].number, name: c.picks[0].name, odds: c.picks[0].odds, ev: c.picks[0].ev, grade: c.picks[0].grade, prob: c.picks[0].prob } : null,
          second:  c.picks?.[1] ? { number: c.picks[1].number, name: c.picks[1].name, odds: c.picks[1].odds, ev: c.picks[1].ev, grade: c.picks[1].grade } : null,
          third:   c.picks?.[2] ? { number: c.picks[2].number, name: c.picks[2].name, odds: c.picks[2].odds, ev: c.picks[2].ev, grade: c.picks[2].grade } : null,
          confidence: c.confidence,
          hasOverpop:  (c.overpopular || []).length > 0,
          hasUnderval: (c.undervalued || []).length > 0,
          trackBiasNote: c.raceMeta?.trackBiasNote || null,
          horseCount: Array.isArray(race.horses) ? race.horses.length : 0,
        };
      });
      // 発走時刻順 (取得できれば) → race_id 順 の安定ソート
      summaries.sort((a, b) => {
        if (a.startTime && b.startTime) return a.startTime.localeCompare(b.startTime);
        return String(a.raceId || "").localeCompare(String(b.raceId || ""));
      });
      return ok(res, { ok: true, fetchedAt: new Date().toISOString(), raceCount: summaries.length, races: summaries });
    }
    if (path === "/win5") {
      const { buildWin5, formatWin5 } = require("../lib/win5_engine");
      const races = readAllRaces();
      if (!races.length) {
        return bad(res, 503, { ok: false, status: "unavailable", reason: "出走馬データ未取得" });
      }
      // 日曜の WIN5 対象は当日の指定 5 レース。データが揃わない時は
      // 「先頭 5 レース」をフォールバックで使う
      const sundayRaces = races.filter(r => {
        const t = r.race_start || r.start_time;
        if (!t) return false;
        return new Date(t).getDay() === 0;
      });
      const candidates = (sundayRaces.length >= 5 ? sundayRaces : races).slice(0, 5);
      const win5 = buildWin5(candidates);
      return ok(res, { ok: true, ...formatWin5(win5), candidateRaceIds: candidates.map(r => r.race_id || null) });
    }
    if (path === "/news-annotated") {
      const { annotateRaceWithNews } = require("../lib/news_sentiment");
      const newsData = await fetchNews();
      const race = readLatestRace();
      if (!race) return bad(res, 503, { ok: false, reason: "レースデータ未取得" });
      const annotated = annotateRaceWithNews(race, newsData?.items || []);
      return ok(res, {
        ok: true,
        raceId: race.race_id || null,
        annotated,
        newsCount: (newsData?.items || []).length,
      });
    }
    if (path === "/refresh") { clearCache(); return ok(res, { ok: true }); }
    if (path === "/venues") return ok(res, { ok: true, venues: loadVenues() });
    if (path === "/connection") {
      const { getConnectionStatus } = require("../lib/connection_status");
      return ok(res, getConnectionStatus());
    }
    if (path === "/model-info") {
      // LightGBM モデルメタ + 利用可能な predictor 一覧を返す (AI 比較カード用)
      try {
        const fs = require("fs");
        const pth = require("path");
        const metaPath = pth.join(__dirname, "..", "data", "jv_cache", "model_lgbm_meta.json");
        let meta = null;
        if (fs.existsSync(metaPath)) {
          meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        }
        const { listPredictors } = require("../predictors");
        const LgbmEval = require("../predictors/lightgbm_eval");
        return ok(res, {
          ok: true,
          predictors: listPredictors(),
          lightgbm: {
            available: LgbmEval.isAvailable(),
            meta,
          },
        });
      } catch (e) {
        return ok(res, { ok: false, error: e.message });
      }
    }
    if (path === "/result") {
      const { readResultAsync, listResults } = require("../lib/finalize");
      const raceId = firstQuery(req.query?.raceId);
      if (raceId) {
        const r = await readResultAsync(String(raceId));
        if (!r) return bad(res, 404, { ok: false, reason: "結果データなし(JV-Link接続後に取得)" });
        return ok(res, { ok: true, result: r });
      }
      return ok(res, { ok: true, available: listResults() });
    }
    if (path === "/finalize") {
      if (req.method !== "POST") return methodNotAllowed(res, "POST");
      const { finalizeBatchAsync } = require("../lib/finalize");
      let payload;
      try {
        payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      } catch (e) {
        return bad(res, 400, { ok: false, error: "リクエスト本文の JSON が不正です: " + (e?.message || e) });
      }
      const bets = Array.isArray(payload.bets) ? payload.bets : [];
      const updates = await finalizeBatchAsync(bets);
      return ok(res, { ok: true, count: updates.length, updates });
    }
    if (path === "/g1-history") {
      const { readG1, listG1 } = require("../lib/g1_history");
      const id = firstQuery(req.query?.id);
      if (id) {
        const r = readG1(String(id));
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
