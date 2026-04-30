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

function readLatestRace() {
  const p = path.join(CACHE_DIR, "latest_race.json");
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  // fallback: races/*.json の先頭を返す
  const all = readAllRaces();
  return all && all.length ? all[0] : null;
}

// 複数レース対応: data/jv_cache/races/*.json を読む
// 1ファイル1レース or 1ファイルに配列(複数レース) のどちらにも対応。
function readAllRaces() {
  const dir = path.join(CACHE_DIR, "races");
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith(".json")); }
  catch { /* フォルダなし */ }
  // races フォルダにファイルがあればそれを優先。なければ latest_race.json を 1件として返す。
  if (files.length === 0) {
    const latest = readLatestRace();
    return latest ? [latest] : [];
  }
  const races = [];
  for (const f of files) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (Array.isArray(arr)) races.push(...arr);
      else races.push(arr);
    } catch { /* skip broken file */ }
  }
  return races;
}

module.exports = { listJvCache, readJvStatus, readLatestRace, readAllRaces, CACHE_DIR };
