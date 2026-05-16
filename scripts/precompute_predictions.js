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
    console.error(`[NG] 対象レースがありません (today=${today} / tomorrow=${tmr}, 全 ${all.length} 件中 0 件)`);
    process.exit(1);
  }
  console.log(`[info] 対象 ${files.length} レース (${wantAll ? "全件" : "当日+翌日"}) / 全ファイル ${all.length}`);

  const startMs = Date.now();
  const predictions = {};
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
  if (lgbm) console.log(`     LightGBM: ${lgbm.state ?? "?"} / AUC ${lgbm.metrics?.auc ?? "?"} / trained ${lgbm.trained_at ?? "?"}`);
}

try {
  main();
} catch (e) {
  console.error("[FATAL] 例外:", e.stack || e.message);
  process.exit(2);
}
