"use strict";
const { loadVenues } = require("../lib/venues");

module.exports = (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=86400");
  res.status(200).json({ ok: true, venues: loadVenues() });
};
