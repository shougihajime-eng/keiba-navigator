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
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

module.exports = { listJvCache, readJvStatus, readLatestRace, CACHE_DIR };
