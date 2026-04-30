"use strict";
const http = require("http");
const https = require("https");

function fetchUrl(target, opts = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch (e) { return reject(e); }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(u, { headers: {
      "User-Agent": "KeibaNavigator/0.1 (personal)",
      "Accept-Language": "ja,en;q=0.5",
      ...(opts.headers || {}),
    }}, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && (opts.redirects || 0) < 5) {
        const next = new URL(res.headers.location, target).href;
        return fetchUrl(next, { ...opts, redirects: (opts.redirects || 0) + 1 }).then(resolve, reject);
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
        headers: res.headers,
      }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
  });
}

// 簡易メモリキャッシュ (TTL付)
const _cache = new Map();
function getCache(k, ttlMs) {
  const c = _cache.get(k);
  if (c && Date.now() - c.ts < ttlMs) return c.data;
  return null;
}
function setCache(k, data) { _cache.set(k, { ts: Date.now(), data }); }
function clearCache() { _cache.clear(); }

module.exports = { fetchUrl, getCache, setCache, clearCache };
