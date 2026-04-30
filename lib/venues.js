"use strict";
const fs = require("fs");
const path = require("path");

let _cached = null;
function loadVenues() {
  if (_cached) return _cached;
  const p = path.join(__dirname, "..", "data", "venues.json");
  _cached = JSON.parse(fs.readFileSync(p, "utf8"));
  return _cached;
}

module.exports = { loadVenues };
