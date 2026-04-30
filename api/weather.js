"use strict";
const { fetchAllWeather } = require("../lib/weather");

module.exports = async (req, res) => {
  try {
    const data = await fetchAllWeather();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate");
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
