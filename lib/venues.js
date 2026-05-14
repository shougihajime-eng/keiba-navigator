"use strict";
const fs = require("fs");
const path = require("path");

let _cached = null;
function loadVenues() {
  if (_cached) return _cached;
  // __dirname を基準にして cwd 非依存で読む (Vercel Functions では cwd が /var/task)。
  // data/venues.json は npm package or Vercel deployment に含まれる前提。
  const p = path.join(__dirname, "..", "data", "venues.json");
  try {
    _cached = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.warn("[venues] load failed:", e.message, "path=", p);
    _cached = [];
  }
  return _cached;
}

module.exports = { loadVenues };
