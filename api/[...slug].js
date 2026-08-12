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
const predCache             = require("../lib/predictions_cache");
const lightgbm_v1           = require("../predictors/lightgbm_v1");

// 成功応答: 事前に Cache-Control が設定されていればそれを尊重 (CDN キャッシュ)。
// 未設定なら従来通り no-store (安全側)。
function ok(res, body)  {
  if (!res.getHeader("Cache-Control")) res.setHeader("Cache-Control", "no-store");
  res.status(200).json(body);
}
// エラー応答は常に no-store (4xx/5xx を CDN に焼き付けない)
function bad(res, code, body) { res.setHeader("Cache-Control", "no-store"); res.status(code).json(body); }

// ─── CDN キャッシュ方針 (2026-06-04 高速化) ───
// データは「ローカル PC → git push → Vercel デプロイ」でしか変わらず、
// デプロイのたびに Vercel の CDN キャッシュは自動で全消去される。
// → GET のデータ系 API は s-maxage で CDN に置いても古くならない。
// ブラウザ側は max-age=0 (毎回 CDN に確認) なので体感は常に最新・応答は数十 ms。
// [s-maxage 秒, stale-while-revalidate 秒]
const CACHE_POLICY = {
  "/status":            [60, 600],
  "/races":             [30, 600],
  "/win5":              [60, 600],
  "/race":              [60, 600],
  "/conclusion":        [60, 600],
  "/recommendations":   [300, 3600],
  "/race-card":         [300, 3600],
  "/rankings":          [300, 3600],
  "/ml-status":         [300, 3600],
  "/learning-status":   [60, 600],
  "/model-info":        [300, 3600],
  "/experiment-status": [300, 3600],
  "/experiment-history":[300, 3600],
  "/g1-history":        [300, 3600],
  "/result":            [120, 3600],
  "/venues":            [3600, 86400],
  "/connection":        [60, 600],
  "/automation-status": [60, 600],
  "/schedule":          [30, 300],
  "/weather":           [600, 1800],
  "/news":              [600, 1800],
  "/news-annotated":    [600, 1800],
};
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

  // GET のデータ系 API は CDN キャッシュを許可 (ok() がこのヘッダを尊重する)
  if (req.method === "GET" && CACHE_POLICY[path]) {
    const [smax, swr] = CACHE_POLICY[path];
    res.setHeader("Cache-Control", `public, max-age=0, s-maxage=${smax}, stale-while-revalidate=${swr}`);
  }

  try {
    if (path === "/status")     return ok(res, buildStatus());
    if (path === "/recommendations") {
      // Wave19: 推奨買い目 (fuku_top1_prob_020 = AI 本命の確率 20%+ で複勝 100 円)
      const rec = lightgbm_v1.loadRecommendations();
      if (!rec) return ok(res, { ok: false, reason: "no_recommendations" });
      return ok(res, { ok: true, ...rec });
    }
    if (path === "/race-card") {
      // 2026-05-26: 直近開催日の全レース・全頭カード (全レース予想を正直に表示)
      const card = lightgbm_v1.loadRaceCard();
      if (!card) return ok(res, { ok: false, reason: "no_race_card" });
      return ok(res, card);
    }
    if (path === "/rankings") {
      // 2026-05-26: 騎手・調教師ランキング (過去全レースの着順から集計)
      const r = lightgbm_v1.loadRankings();
      if (!r) return ok(res, { ok: false, reason: "no_rankings" });
      return ok(res, r);
    }
    if (path === "/odds-history") {
      // 2026-08-12 新設: オッズ推移（発走までの単勝オッズの動き）。
      //   ⚠「直前5分の変化率」は 1時間おき収集の期間は 0件（起点が古すぎる）。
      //     2分おきの KeibaNearPostOdds が回り始めた週末から出る。理由は画面に出す。
      try {
        const raceId = firstQuery(req.query && req.query.raceId)
          || (new URL(req.url, "http://localhost").searchParams.get("raceId"));
        if (!raceId) return bad(res, 400, { ok: false, reason: "raceId が要ります" });
        const OH = require("../lib/odds_history");
        const wm = firstQuery(req.query && req.query.windowMin);
        const d = OH.readOddsHistory(String(raceId), wm != null ? { windowMin: Number(wm) } : undefined);
        return ok(res, d);
      } catch (e) {
        return bad(res, 500, { ok: false, error: e.message });
      }
    }
    if (path === "/umabashira") {
      // 2026-08-12 新設: 馬柱（各馬の過去5走）。netkeiba等の中核なのにこのアプリに無かった。
      //   ?raceId=<18桁> で、そのレースの出走各馬の過去5走を返す。
      try {
        const raceId = firstQuery(req.query && req.query.raceId)
          || (new URL(req.url, "http://localhost").searchParams.get("raceId"));
        if (!raceId) return bad(res, 400, { ok: false, reason: "raceId が要ります" });
        const U = require("../lib/umabashira.js");
        const fsx = require("fs"), px = require("path");
        const p = px.join(__dirname, "..", "data", "jv_cache", "umabashira.json");
        if (!fsx.existsSync(p)) return ok(res, { ok: false, reason: "no_umabashira" });
        const uma = JSON.parse(fsx.readFileSync(p, "utf8"));
        const rows = U.rowsForRaceId(uma, String(raceId));
        if (!rows || !rows.length) return ok(res, { ok: false, reason: "not_in_index" });
        return ok(res, { ok: true, raceId: String(raceId), columns: uma.columns || U.COLUMNS || [], rows });
      } catch (e) {
        return bad(res, 500, { ok: false, error: e.message });
      }
    }
    if (path === "/live-stats") {
      // 2026-08-11: 「実際に買っていたらいくらになったか」の本物の成績 + 毎週の学習けっか。
      //   これまで画面には検証(バックテスト)の良い数字しか出しておらず、
      //   本当は 14 個の買い方すべてが 100% 割れ (合計 -151,620 円) だった。
      //   嘘をつかないため、この本物の数字を画面のいちばん上に出す。
      const live = lightgbm_v1.loadLiveStats();
      const umami = lightgbm_v1.loadUmamiStatus();
      if (!live && !umami) return ok(res, { ok: false, reason: "no_live_stats" });
      return ok(res, { ok: true, live, umami });
    }
    if (path === "/ml-status") {
      // LightGBM の学習メタ + 過去レース実証結果 (回収率)
      const meta = lightgbm_v1.loadModelMeta();
      const metaNopop = lightgbm_v1.loadModelMetaNopop();
      const backtest = lightgbm_v1.loadBacktest();
      const buildModelView = (m) => m ? {
        trainedAt: m.trained_at,
        samplesTotal: m.samples_total,
        racesTotal: m.races_total,
        samplesTrain: m.samples_train,
        samplesTest: m.samples_test,
        auc: m.metrics ? m.metrics.auc : null,
        logloss: m.metrics ? m.metrics.logloss : null,
        noPop: !!m.no_pop,
        featureImportanceTop: m.feature_importance
          ? Object.entries(m.feature_importance).sort((a,b) => b[1]-a[1]).slice(0,8)
              .map(([name, gain]) => ({ name, gain }))
          : null,
      } : null;
      return ok(res, {
        ok: true,
        fetchedAt: new Date().toISOString(),
        modelAvailable: !!meta,
        nopopAvailable: !!metaNopop,
        backtestAvailable: !!backtest,
        model: buildModelView(meta),
        modelNopop: buildModelView(metaNopop),
        backtest: backtest ? {
          backtestedAt: backtest.backtested_at,
          testRaces: backtest.test_races,
          bestStrategy: backtest.best_strategy,
          bestRoiPct: backtest.best_roi_pct,
          strategies: backtest.strategies,
        } : null,
      });
    }
    if (path === "/learning-status") {
      // AI が裏で何回学習したかを 1 タップで分かる形で返す (UI のホームに出す用)
      const meta = predCache.predictionsMeta();
      const learning = predCache.readLearningStatus() || {};
      return ok(res, {
        ok: true,
        fetchedAt: new Date().toISOString(),
        predictionsAvailable: !!meta,
        predictionsFresh: predCache.isPredictionsFresh(),
        predictionsMeta: meta,
        lgbm: learning.lgbm || null,
        features: learning.features || null,
      });
    }
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
      // ★Wave14: 事前計算 predictions.json があれば最優先 (Vercel ServerlessFunction 内も瞬時応答)
      const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const tmrDate = new Date(Date.now() + 24*60*60*1000).toISOString().slice(0, 10).replace(/-/g, "");
      const predMap = predCache.readPredictionsMap();
      if (predMap && predCache.isPredictionsFresh()) {
        const preComputed = Object.values(predMap).filter(r => {
          const id = String(r.race_id || "");
          if (id.length >= 8 && /^\d{8}/.test(id)) {
            const d = id.slice(0, 8);
            return d === todayStr || d === tmrDate;
          }
          return true;
        });
        if (preComputed.length > 0) {
          const summaries = preComputed.map(r => ({
            raceName: r.race_name || null,
            raceId: r.race_id || null,
            course: r.course || null,
            venue: null,
            surface: r.surface || null,
            distance: r.distance || null,
            startTime: r.start_time || null,
            isDummy: false,
            isG1: !!r.is_g1,
            verdict: r.verdict,
            verdictTitle: r.verdictTitle,
            topGrade: r.topPick?.evGrade || null,
            topPick: r.topPick,
            second: r.second,
            third: r.third,
            exotic: r.exotic || null,
            overlays: r.overlays || null,
            nopopPick: r.nopopPick || null,  // 2026-08-11: 人気を見ないAIの本命 (⚠ server.js 側にも同じ1行が必要)
            confidence: r.confidence,
            hasOverpop: !!r.hasOverpop,
            hasUnderval: !!r.hasUnderval,
            trackBiasNote: r.trackBiasNote,
            horseCount: r.horse_count || 0,
          }));
          summaries.sort((a, b) => {
            if (a.startTime && b.startTime) return a.startTime.localeCompare(b.startTime);
            return String(a.raceId || "").localeCompare(String(b.raceId || ""));
          });
          return ok(res, {
            ok: true,
            fetchedAt: new Date().toISOString(),
            source: "precomputed",
            computedAt: predCache.predictionsMeta()?.fetchedAt,
            learning: predCache.readLearningStatus(),
            honmeiLog: predCache.readHonmeiLog(),
            raceCount: summaries.length,
            races: summaries,
          });
        }
      }

      // フォールバック: 事前計算ファイル無し or 古い → on-the-fly 計算
      const allRaces = readAllRaces();
      if (!allRaces.length) {
        return bad(res, 503, {
          ok: false, status: "unavailable", races: [],
          reason: "出走馬データはまだ取得していません。JRA-VAN（有料）の接続設定後に表示されます。",
        });
      }
      const filtered = allRaces.filter(r => {
        const id = String(r.race_id || "");
        if (id.length >= 8 && /^\d{8}/.test(id)) {
          const d = id.slice(0, 8);
          return d === todayStr || d === tmrDate;
        }
        return true;  // 非 JRA 形式 (manual_ 等) は素通し
      });
      if (filtered.length === 0) {
        // 当日+翌日のデータ無し → 過去レースを「今日の予想」として誤表示しないよう空で返す
        return ok(res, {
          ok: true,
          fetchedAt: new Date().toISOString(),
          source: "no_today",
          learning: predCache.readLearningStatus(),
          raceCount: 0,
          races: [],
          reason: "本日と明日の開催レースはまだ取り込まれていません",
        });
      }
      const races = filtered;
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
          topPick: c.picks?.[0] ? { number: c.picks[0].number, name: c.picks[0].name, odds: c.picks[0].odds, ev: c.picks[0].ev, grade: c.picks[0].grade, prob: c.picks[0].prob, place: c.picks[0].place } : null,
          second:  c.picks?.[1] ? { number: c.picks[1].number, name: c.picks[1].name, odds: c.picks[1].odds, ev: c.picks[1].ev, grade: c.picks[1].grade, prob: c.picks[1].prob, place: c.picks[1].place } : null,
          third:   c.picks?.[2] ? { number: c.picks[2].number, name: c.picks[2].name, odds: c.picks[2].odds, ev: c.picks[2].ev, grade: c.picks[2].grade, prob: c.picks[2].prob, place: c.picks[2].place } : null,
          exotic: c.exotic || null,
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
      return ok(res, { ok: true, fetchedAt: new Date().toISOString(), honmeiLog: predCache.readHonmeiLog(), raceCount: summaries.length, races: summaries });
    }
    if (path === "/win5") {
      const { buildWin5, formatWin5 } = require("../lib/win5_engine");
      const allRaces = readAllRaces();
      if (!allRaces.length) {
        return bad(res, 503, { ok: false, status: "unavailable", reason: "出走馬データ未取得" });
      }
      // ★Wave9-fix: 当日+翌日のレースのみに絞る
      const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const tmrDate = new Date(Date.now() + 24*60*60*1000).toISOString().slice(0, 10).replace(/-/g, "");
      const races = allRaces.filter(r => {
        const id = String(r.race_id || "");
        if (id.length >= 8 && /^\d{8}/.test(id)) {
          const d = id.slice(0, 8);
          return d === todayStr || d === tmrDate;
        }
        return true;
      });
      const sundayRaces = races.filter(r => {
        const t = r.race_start || r.start_time;
        if (!t) return false;
        return new Date(t).getDay() === 0;
      });
      // 当日+翌日のレースが無いなら WIN5 は組めない
      if (races.length === 0) {
        return ok(res, {
          ok: false, perRace: [], strategies: {}, recommended: null, avgConfidence: 0,
          note: "本日と明日の開催レースがまだ取り込まれていません", candidateRaceIds: [],
        });
      }
      const candidates = (sundayRaces.length >= 5 ? sundayRaces : races).slice(0, 5);
      // ★Wave15.1: クエリ ?budget=3000 / ?mode=hit / ?plan=1,1,2,2,2
      const budgetStr = firstQuery(req.query?.budget);
      const modeStr = firstQuery(req.query?.mode);
      const planStr = firstQuery(req.query?.plan);
      const opts = {};
      const budget = parseInt(budgetStr, 10);
      if (Number.isFinite(budget) && budget >= 200) opts.budget = budget;
      if (modeStr === "hit") opts.mode = "hit";
      if (typeof planStr === "string" && /^\d+(,\d+){0,4}$/.test(planStr)) {
        const arr = planStr.split(",").map(x => parseInt(x, 10)).filter(Number.isFinite);
        if (arr.length === 5 && arr.every(n => n >= 1 && n <= 8)) opts.customPlan = arr;
      }
      const win5 = buildWin5(candidates, opts);
      // Wave31: 真の Walk-forward (期間別 nopop 再学習) 結果を併載
      let win5WfResult = null;
      try {
        const fs = require("fs");
        const path = require("path");
        const wfPath = path.join(process.cwd(), "data", "jv_cache", "walk_forward_win5_v1_result.json");
        if (fs.existsSync(wfPath)) {
          const wf = JSON.parse(fs.readFileSync(wfPath, "utf8"));
          win5WfResult = {
            leakage_free: !!wf.leakage_free,
            evaluated_at: wf.evaluated_at,
            total_days_evaluated: wf.total_days_evaluated,
            summary: wf.summary,
            method: wf.method,
          };
        }
      } catch (e) { /* fallback: 検証結果なし */ }
      return ok(res, { ok: true, ...formatWin5(win5), wf: win5WfResult, candidateRaceIds: candidates.map(r => r.race_id || null) });
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
    if (path === "/experiment-status" || path === "/experiment-history") {
      // 自己成長する実験モード(実験室)の正直な採点結果
      const fs = require("fs");
      const pth = require("path");
      const fname = path === "/experiment-status" ? "experiment_status.json" : "experiment_history.json";
      try {
        const fp = pth.join(__dirname, "..", "data", "jv_cache", fname);
        const data = JSON.parse(fs.readFileSync(fp, "utf8"));
        return ok(res, data);
      } catch (e) {
        return ok(res, { ok: false, reason: "実験データ未生成(週末データ後に集計されます)" });
      }
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
    if (path === "/cron-finalize") {
      // Vercel cron 経由でのみ実行: Authorization: Bearer ${CRON_SECRET}
      const secret = process.env.CRON_SECRET || null;
      const auth = req.headers?.authorization || "";
      const isCron = !!secret && auth === `Bearer ${secret}`;
      // 管理者の手動キックも許可: ?key=<CRON_SECRET>
      const queryKey = firstQuery(req.query?.key);
      const isManual = !!secret && queryKey === secret;
      if (!isCron && !isManual) {
        return bad(res, 401, { ok: false, error: "Unauthorized. CRON_SECRET required." });
      }
      const { runCronFinalize } = require("../lib/cron_finalize");
      const summary = await runCronFinalize();
      return ok(res, summary);
    }
    if (path === "/automation-status") {
      // 自動化レイヤーの健康状態をまとめて返す (アプリのカードが読む)
      const fs = require("fs");
      const pth = require("path");
      const meta = predCache.predictionsMeta();
      const learning = predCache.readLearningStatus() || {};
      const status = buildStatus();
      let lastCommitISO = null;
      try {
        const headPath = pth.join(__dirname, "..", ".git", "HEAD");
        if (fs.existsSync(headPath)) {
          const head = fs.readFileSync(headPath, "utf8").trim();
          if (head.startsWith("ref: ")) {
            const ref = head.slice(5);
            const refPath = pth.join(__dirname, "..", ".git", ref);
            if (fs.existsSync(refPath)) {
              lastCommitISO = fs.statSync(refPath).mtime.toISOString();
            }
          }
        }
      } catch {}
      // 次回 Vercel cron は毎日 14:00 UTC (23:00 JST)
      const nowMs = Date.now();
      const nextCron = new Date();
      nextCron.setUTCHours(14, 0, 0, 0);
      if (nextCron.getTime() <= nowMs) nextCron.setUTCDate(nextCron.getUTCDate() + 1);
      return ok(res, {
        ok: true,
        fetchedAt: new Date().toISOString(),
        jvBridge: status.jvBridge || null,
        lastDataFetch: status.jvBridge?.updatedAt || null,
        predictionsFresh: predCache.isPredictionsFresh(),
        predictionsComputedAt: meta?.fetchedAt || null,
        lastGitPushDeploy: lastCommitISO,
        nextCronFinalizeISO: nextCron.toISOString(),
        learning,
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
