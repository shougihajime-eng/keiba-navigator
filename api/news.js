"use strict";
const { fetchNews } = require("../lib/news");

module.exports = async (req, res) => {
  try {
    const data = await fetchNews();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate");
    res.status(data.ok ? 200 : 502).json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
