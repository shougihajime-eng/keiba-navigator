"use strict";
const { clearCache } = require("../lib/fetch");

module.exports = (req, res) => {
  clearCache();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ ok: true });
};
