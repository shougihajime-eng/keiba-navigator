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
  } catch { return []; }
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
  catch { return []; }
  const races = [];
  for (const f of files) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (Array.isArray(arr)) races.push(...arr);
      else races.push(arr);
    } catch {}
  }
  return races;
}

// ── 公開API ──────────────────────────────────────────────────
// readAllRaces: races/ にあれば優先、なければ latest_race.json を1件として返す
function readAllRaces() {
  const fromDir = _readRacesFiles();
  if (fromDir.length > 0) return fromDir;
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
