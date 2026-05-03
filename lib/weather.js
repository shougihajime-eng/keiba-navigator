"use strict";
const { fetchUrl, getCache, setCache } = require("./fetch");
const { loadVenues } = require("./venues");

// 気象庁の更新間隔は数時間単位なので、キャッシュは長めに保持してレート負荷を下げる
const TTL_MS = 15 * 60 * 1000;

function parseJmaToday(arr) {
  if (!Array.isArray(arr) || !arr[0]) return null;
  const office = arr[0];
  const ts0 = office.timeSeries?.[0];
  const area = ts0?.areas?.[0];
  if (!area) return null;
  return {
    areaName: area.area?.name || null,
    weather: area.weathers?.[0] || null,
    wind:    area.winds?.[0]    || null,
  };
}

async function fetchWeatherFor(venue) {
  const key = "w:" + venue.id;
  const cached = getCache(key, TTL_MS);
  if (cached) return cached;
  const url = `https://www.jma.go.jp/bosai/forecast/data/forecast/${venue.areaCode}.json`;
  try {
    const r = await fetchUrl(url);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const arr = JSON.parse(r.body);
    const data = {
      ok: true, venue,
      fetchedAt: new Date().toISOString(),
      source: "気象庁 forecast API (jma.go.jp)",
      publishingOffice: arr[0]?.publishingOffice || null,
      reportDatetime: arr[0]?.reportDatetime || null,
      today: parseJmaToday(arr),
    };
    setCache(key, data);
    return data;
  } catch (e) {
    return { ok: false, venue, error: String(e.message || e), source: "気象庁 forecast API" };
  }
}

async function fetchAllWeather() {
  const venues = loadVenues();
  const all = await Promise.all(venues.map(v => fetchWeatherFor(v)));
  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    source: "気象庁 forecast API",
    venues: all,
  };
}

module.exports = { fetchWeatherFor, fetchAllWeather };
