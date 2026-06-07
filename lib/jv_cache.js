"use strict";
const fs = require("fs");
const path = require("path");

const CACHE_DIR = path.join(__dirname, "..", "data", "jv_cache");

function listJvCache() {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(".json") && !f.startsWith("_"));
    return files.map(f => {
      const full = path.join(CACHE_DIR, f);
      const stat = fs.statSync(full);
      return { file: f, mtime: stat.mtime.toISOString(), size: stat.size };
    }).sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch (e) {
    // ENOENT は無視 (ディレクトリ未作成)。それ以外のエラーは原因究明のためにログ。
    if (e?.code !== "ENOENT") {
      console.warn("[jv_cache] listJvCache failed:", e.message);
    }
    return [];
  }
}

function readJvStatus() {
  const p = path.join(CACHE_DIR, "_status.json");
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// ── 内部ヘルパ (非再帰) ─────────────────────────────────────
function _readLatestFile() {
  const p = path.join(CACHE_DIR, "latest_race.json");
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function _readRacesFiles() {
  const dir = path.join(CACHE_DIR, "races");
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith(".json")); }
  catch (e) {
    if (e?.code !== "ENOENT") {
      console.warn("[jv_cache] readdir races/ failed:", e.message);
    }
    return [];
  }
  const races = [];
  for (const f of files) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (Array.isArray(arr)) races.push(...arr);
      else races.push(arr);
    } catch (e) {
      console.warn("[jv_cache] parse race file failed:", f, e.message);
    }
  }
  return races;
}

// 🚨 2026-06-07: 本番 (Vercel) には races/*.json が git 管理外で存在しないため、
// readAllRaces() が常に空 → /api/win5 が本番で一度も動かず 503 を返し続けていた。
// precompute_predictions.js が書く today_races.json (当日+翌日の完全レースデータ・
// git 管理) をフォールバックとして読む。
function _readTodayRacesFile() {
  const p = path.join(CACHE_DIR, "today_races.json");
  try {
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(d?.races) ? d.races : [];
  } catch { return []; }
}

// ── 公開API ──────────────────────────────────────────────────
// readAllRaces: races/ にあれば優先 → today_races.json → latest_race.json
function readAllRaces() {
  const fromDir = _readRacesFiles();
  if (fromDir.length > 0) return fromDir;
  const fromToday = _readTodayRacesFile();
  if (fromToday.length > 0) return fromToday;
  const latest = _readLatestFile();
  return latest ? [latest] : [];
}

// readLatestRace: latest_race.json を優先、なければ races/ の先頭
function readLatestRace() {
  const latest = _readLatestFile();
  if (latest) return latest;
  const fromDir = _readRacesFiles();
  return fromDir.length > 0 ? fromDir[0] : null;
}

module.exports = { listJvCache, readJvStatus, readLatestRace, readAllRaces, CACHE_DIR };
