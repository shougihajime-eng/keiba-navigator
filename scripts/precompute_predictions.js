#!/usr/bin/env node
"use strict";

/**
 * scripts/precompute_predictions.js
 *
 * 全レースの予想 (verdict / picks / EV / 信頼度 / 馬場バイアス) を pipeline で 1 回だけ計算し、
 *   data/jv_cache/predictions.json
 * に書き出す。/api/races と /api/race はこのファイルを最優先で読むようにする。
 *
 * これにより:
 *  - スマホ・パソコンで開いた瞬間に予想が表示される (待ち時間ゼロ)
 *  - 4 回/日のスケジュールタスクで自動再計算される (8:30 / 11:00 / 13:30 / 16:00)
 *  - 利用者が触らなくても、AI は裏で予想を更新し続ける
 *
 * 使い方:
 *   node scripts/precompute_predictions.js
 *
 * 終了コード:
 *   0  正常 (predictions.json 書き出し成功)
 *   1  races/ が空 (データ未取得)
 *   2  内部エラー
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const RACES_DIR  = path.join(ROOT, "data", "jv_cache", "races");
const FEATS_PATH = path.join(ROOT, "data", "jv_cache", "features.json");
const OUT_PATH   = path.join(ROOT, "data", "jv_cache", "predictions.json");
// 🚨 2026-06-07: 本番 (Vercel) には races/*.json が無い (git 管理外) ため、
// readAllRaces() が常に空 → /api/win5 が本番で一度も動かず 503 だった。
// 当日+翌日の「完全なレース JSON」を 1 ファイルにまとめて git に乗せ、
// lib/jv_cache.readAllRaces のフォールバックとして本番でも読めるようにする。
const TODAY_RACES_PATH = path.join(ROOT, "data", "jv_cache", "today_races.json");

let buildConclusion;
let evGrade;
try {
  const conclusionMod = require(path.join(ROOT, "lib", "conclusion"));
  buildConclusion = conclusionMod.buildConclusion;
  evGrade = conclusionMod.evGrade;
} catch (e) {
  console.error("[FATAL] lib/conclusion.js の読み込みに失敗:", e.message);
  process.exit(2);
}

// ─── うまみ(overlay)候補を直前オッズから計算して予想に同梱 ─────────────
// KeibaExoticOdds が貯めた data/jv_cache/exotic_odds/<raceid16>/*.json の最終スナップを読み、
// lib/overlay.js で「単勝由来の本当の確率 × 連系オッズ > 1」の割安な組合せを探す。
// スナップが無ければ null(=画面に出さない)。本体を壊さないよう必ず try/catch。
let _overlayMod = null;
try { _overlayMod = require(path.join(ROOT, "lib", "overlay")); } catch { _overlayMod = null; }
const EXOTIC_ODDS_DIR = path.join(ROOT, "data", "jv_cache", "exotic_odds");
function loadOverlaysFor(raceId) {
  if (!_overlayMod) return null;
  try {
    let rid = String(raceId || "");
    if (rid.length === 18 && rid.endsWith("00")) rid = rid.slice(0, 16);
    const dir = path.join(EXOTIC_ODDS_DIR, rid);
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
    if (!files.length) return null;
    files.sort((a, b) => Number(a.replace(".json", "")) - Number(b.replace(".json", "")));
    const snap = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), "utf-8"));
    if (!snap || !snap.odds || !snap.odds.tansho) return null;
    const wp = _overlayMod.buildWinProb(snap.odds.tansho.items);
    const ov = _overlayMod.findOverlays(wp, snap, { minEV: 1.15, minProb: 0.03 });
    if (!ov.length) return null;
    return {
      fetchedAt: snap.fetchedAt || null,
      items: ov.slice(0, 6).map(x => ({
        type: x.type, key: x.key,
        prob: Math.round(x.prob * 1000) / 1000,
        odds: x.odds, ev: Math.round(x.ev * 100) / 100,
      })),
    };
  } catch { return null; }
}

// ─── 2026-08-11 新設: 「人気を見ないAI」の本命を本番へ運ぶ ─────────────
// これまで画面に出る本命は市場オッズそのままで、実測すると 77.2% が 1 番人気だった
// (4,380 レース中 3,383 レース)。持ち主から「1 番人気ばかりしか買わない」と指摘された。
// 一方 Python 側 (predict_lightgbm.py) は「人気を見ないAI(nopop)」も同時に計算しており、
// 実測で 52.1% のレースで別の馬を推していた。しかしその答えを本番へ運ぶ処理が
// どこにも無く、画面に一度も出ていなかった。ここで運ぶ。
const PRED_DIR = path.join(ROOT, "data", "jv_cache", "predictions");
function loadNopopPickFor(raceId) {
  try {
    const rid = String(raceId || "");
    if (!rid) return null;
    // predictions/ は 18 桁 (末尾00) でも 16 桁でも置かれうるので両方ためす
    const cands = [rid, rid.length === 16 ? rid + "00" : null, rid.length === 18 ? rid.slice(0, 16) : null]
      .filter(Boolean)
      .map((x) => path.join(PRED_DIR, x + ".json"));
    const hit = cands.find((p) => fs.existsSync(p));
    if (!hit) return null;
    const d = JSON.parse(fs.readFileSync(hit, "utf-8"));
    const horses = (d && Array.isArray(d.horses) ? d.horses : []).filter((h) => h && h.number);
    if (!horses.length) return null;
    const withNopop = horses.filter((h) => Number.isFinite(h.nopop_prob));
    if (!withNopop.length) return null;
    const nTop = withNopop.reduce((a, b) => ((b.nopop_prob || 0) > (a.nopop_prob || 0) ? b : a));
    const mTop = horses.reduce((a, b) => ((b.win_prob || 0) > (a.win_prob || 0) ? b : a));
    return {
      number:     nTop.number ?? null,
      name:       nTop.name ?? null,
      odds:       Number.isFinite(nTop.odds) ? nTop.odds : null,
      popularity: Number.isFinite(nTop.popularity) ? nTop.popularity : null,
      prob:       Number.isFinite(nTop.nopop_prob) ? Math.round(nTop.nopop_prob * 10000) / 10000 : null,
      // 市場寄りの本命と食い違っているか (ここが「1番人気ばかり」の卒業の肝)
      disagrees:  !!(mTop && nTop.number !== mTop.number),
      marketTopNumber: mTop ? (mTop.number ?? null) : null,
      valueSignal: Number.isFinite(nTop.value_signal) ? Math.round(nTop.value_signal * 10000) / 10000 : null,
    };
  } catch { return null; }
}

// LightGBM モデル meta を一緒に乗せる (UI で「最後の学習時刻」を出すため)
function readLgbmMeta() {
  try {
    const p = path.join(ROOT, "data", "jv_cache", "model_lgbm_meta.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch { return null; }
}

function readFeaturesMeta() {
  try {
    if (!fs.existsSync(FEATS_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(FEATS_PATH, "utf-8"));
    return raw && raw._meta ? raw._meta : null;
  } catch { return null; }
}

function summarizePick(p) {
  if (!p) return null;
  const ev = Number.isFinite(p.ev) ? p.ev : null;
  return {
    number:     p.number ?? null,
    name:       p.name ?? null,
    odds:       Number.isFinite(p.odds) ? p.odds : null,
    popularity: Number.isFinite(p.popularity) ? p.popularity : null,
    prob:       Number.isFinite(p.prob) ? p.prob : null,
    place:      Number.isFinite(p.place) ? p.place : null,
    ev,
    evGrade:    typeof evGrade === "function" && ev != null ? evGrade(ev) : null,
    role:       p.role ?? null,
    reason:     p.reason ?? null,
  };
}

function compactConclusion(c, race) {
  // _api/races_ で使う形に圧縮 (フロントが読む summary 用)
  const horses = race.horses || [];
  const picks = (c.picks || []).map(summarizePick);
  const top1  = picks[0] ?? null;
  const top2  = picks[1] ?? null;
  const top3  = picks[2] ?? null;
  return {
    race_id:       race.race_id,
    race_name:     race.race_name ?? null,
    course:        race.course ?? null,
    surface:       race.surface ?? null,
    distance:      race.distance ?? null,
    going:         race.going ?? null,
    weather:       race.weather ?? null,
    is_g1:         !!race.is_g1,
    start_time:    race.startTime || race.start_time || null,
    horse_count:   horses.length,
    has_mining:    !!race.has_mining,
    // 予想結果 (summary)
    verdict:       c.verdict ?? "judgement_unavailable",
    verdictTitle:  c.verdictTitle ?? "判断不可",
    confidence:    Number.isFinite(c.confidence) ? c.confidence : 0,
    topPick:       top1,
    second:        top2,
    third:         top3,
    picks,
    exotic:        c.exotic ?? null,   // ★連系・3連系の正直な的中率(ワイド/3連複)
    overlays:      loadOverlaysFor(race.race_id),  // ★直前オッズ由来の「うまみ候補」(あれば)
    nopopPick:     loadNopopPickFor(race.race_id), // ★人気を見ないAIの本命 (市場と食い違う時が見どころ)
    underval:      c.underval  ? summarizePick(c.underval)  : null,
    overpop:       c.overpop   ? summarizePick(c.overpop)   : null,
    hasUnderval:   !!c.underval,
    hasOverpop:    !!c.overpop,
    suggest:       c.suggest ?? null,
    advice:        c.advice ?? null,
    reasoning:     Array.isArray(c.reasoning) ? c.reasoning : [],
    pacePrediction: c.raceMeta?.pacePrediction ?? null,
    trackBiasNote:  c.raceMeta?.trackBiasNote ?? null,
    model:          c.raceMeta?.model ?? null,
    computed_at:   new Date().toISOString(),
  };
}

function _todayStr() { return new Date().toISOString().slice(0, 10).replace(/-/g, ""); }
function _tomorrowStr() { return new Date(Date.now() + 24*60*60*1000).toISOString().slice(0, 10).replace(/-/g, ""); }

function main() {
  if (!fs.existsSync(RACES_DIR)) {
    console.error("[NG] data/jv_cache/races ディレクトリが存在しません");
    process.exit(1);
  }
  const all = fs.readdirSync(RACES_DIR).filter(f => f.endsWith(".json")).sort();

  // ★当日・翌日のレースだけに絞る (蓄積 10 年分があると全件処理で 10 分超になる)
  // 引数 --all で全件処理 (バックフィル用)
  const wantAll = process.argv.includes("--all");
  const today = _todayStr(), tmr = _tomorrowStr();
  const files = wantAll ? all : all.filter(f => {
    const d = f.slice(0, 8);
    return d === today || d === tmr;
  });

  if (files.length === 0) {
    // ★当日・翌日のレースが無い日 (平日など) は「空の predictions.json」を書く。
    // ここで何も書かずに終了すると、前回レース日の古い predictions.json が残り続け、
    // /api/races が「数日前の終わったレース」を今日の予想として配信してしまう
    // (2026-05-25 修正: 文字化け修正後も古い 5/23 データが本番に残っていた原因)。
    const emptyOut = {
      schema_version: 1,
      fetchedAt:      new Date().toISOString(),
      computedMs:     0,
      raceCount:      0,
      withHorses:     0,
      placeholder:    0,
      failed:         0,
      learning:       { lgbm: readLgbmMeta(), features: readFeaturesMeta() },
      predictions:    {},
    };
    fs.writeFileSync(OUT_PATH, JSON.stringify(emptyOut, null, 0), "utf-8");
    // 本番用の当日レース完全データも空にする (古い週末データの残存防止)
    fs.writeFileSync(TODAY_RACES_PATH, JSON.stringify({ fetchedAt: new Date().toISOString(), races: [] }, null, 0), "utf-8");
    console.log(`[OK] 対象レースなし (today=${today} / tomorrow=${tmr}) → 空の predictions.json を書き出し (古いデータ残存を防止)`);
    process.exit(0);
  }
  console.log(`[info] 対象 ${files.length} レース (${wantAll ? "全件" : "当日+翌日"}) / 全ファイル ${all.length}`);

  const startMs = Date.now();
  const predictions = {};
  const todayRaces = [];  // 当日+翌日の完全なレース JSON (本番 WIN5 等のフォールバック用)
  let withHorses = 0;
  let placeholder = 0;
  let failed = 0;

  let lastLogMs = startMs;
  let i = 0;
  for (const f of files) {
    i++;
    if (i % 50 === 0 || (Date.now() - lastLogMs) > 3000) {
      console.log(`  ... ${i}/${files.length} 処理中`);
      lastLogMs = Date.now();
    }
    const fp = path.join(RACES_DIR, f);
    let race;
    try {
      race = JSON.parse(fs.readFileSync(fp, "utf-8"));
    } catch (e) {
      failed++;
      continue;
    }
    if (!race || !race.race_id) { failed++; continue; }
    let c;
    try {
      c = buildConclusion(race);
    } catch (e) {
      // 1 レース計算失敗でも他は続ける
      console.warn(`[warn] ${race.race_id}: buildConclusion 例外: ${e.message}`);
      c = { verdict: "judgement_unavailable", verdictTitle: "判断不可 (内部エラー)", picks: [], confidence: 0 };
      failed++;
    }
    const summary = compactConclusion(c, race);
    predictions[race.race_id] = summary;
    todayRaces.push(race);
    if ((race.horses || []).length > 0) withHorses++;
    else placeholder++;
  }

  const lgbm  = readLgbmMeta();
  const feats = readFeaturesMeta();

  const out = {
    schema_version: 1,
    fetchedAt:      new Date().toISOString(),
    computedMs:     Date.now() - startMs,
    raceCount:      Object.keys(predictions).length,
    withHorses,
    placeholder,
    failed,
    learning: {
      lgbm: lgbm ? {
        trained_at:        lgbm.trained_at ?? null,
        state:             lgbm.state ?? null,
        races:             lgbm.races ?? null,
        rows:              lgbm.rows ?? null,
        metrics:           lgbm.metrics ?? null,
        feature_importance: lgbm.feature_importance ?? null,
        model:             lgbm.model ?? null,
      } : null,
      features: feats ? {
        racesAnalyzed:  feats.racesAnalyzed ?? null,
        last_updated:   feats.last_updated ?? null,
        jockeyCount:    feats.jockeyCount ?? null,
        trainerCount:   feats.trainerCount ?? null,
        horseCount:     feats.horseCount ?? null,
      } : null,
    },
    predictions,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 0), "utf-8");
  const sizeKb = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);
  console.log(`[OK] predictions.json 書き出し: ${out.raceCount} レース (${withHorses} データあり / ${placeholder} 未配信 / ${failed} 失敗) ${sizeKb} KB / ${out.computedMs}ms`);
  // 本番 (Vercel) で /api/win5 等が読む「当日+翌日の完全レースデータ」
  fs.writeFileSync(TODAY_RACES_PATH, JSON.stringify({ fetchedAt: new Date().toISOString(), races: todayRaces }, null, 0), "utf-8");
  const trKb = (fs.statSync(TODAY_RACES_PATH).size / 1024).toFixed(1);
  console.log(`[OK] today_races.json 書き出し: ${todayRaces.length} レース ${trKb} KB (本番 WIN5 用)`);
  if (lgbm) console.log(`     LightGBM: ${lgbm.state ?? "?"} / AUC ${lgbm.metrics?.auc ?? "?"} / trained ${lgbm.trained_at ?? "?"}`);

  // ★本命の答え合わせログを1日1回(stale時のみ)更新。重い処理なので try/catch で
  //   絶対に本体(予想生成)を巻き込まないようにする(失敗しても無視)。
  try {
    const { buildIfStale } = require("./build-honmei-log.cjs");
    const r = buildIfStale(20, 150);
    if (r) console.log(`[OK] honmei_log.json 更新: ${r.count}レース 単勝${(r.winRate*100).toFixed(1)}% 複勝${(r.placeRate*100).toFixed(1)}%`);
  } catch (e) { console.error("[warn] honmei_log 更新スキップ:", e.message); }
}

try {
  main();
} catch (e) {
  console.error("[FATAL] 例外:", e.stack || e.message);
  process.exit(2);
}
