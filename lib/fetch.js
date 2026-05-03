"use strict";
// HTTP fetch ヘルパ + メモリキャッシュ
//
// 安定性最優先の設計:
//   - 同時並行リクエスト数を制限 (デフォルト 2)
//   - 同URLの並行リクエストはdedup (in-flight共有)
//   - リトライ: 5xx/429/timeout で指数バックオフ + ジッタ (最大3回)
//   - 同一ホストへの最小間隔 (politeness): デフォルト 800ms
//   - キャッシュTTLは呼び出し側で指定 (lib/weather.js, lib/news.js)

const http = require("http");
const https = require("https");

// 設定 (環境変数で上書き可)
const MAX_CONCURRENT = Number(process.env.FETCH_MAX_CONCURRENT || 2);
const POLITE_INTERVAL_MS = Number(process.env.FETCH_POLITE_MS || 800);
const RETRY_MAX = Number(process.env.FETCH_RETRY_MAX || 3);
const TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15000);

// 同時実行スロットル
let _slots = MAX_CONCURRENT;
const _waiters = [];
async function _acquire() {
  if (_slots > 0) { _slots--; return; }
  await new Promise(r => _waiters.push(r));
  _slots--;
}
function _release() {
  _slots++;
  const next = _waiters.shift();
  if (next) next();
}

// 同一ホストの最終アクセス時刻 (politeness wait用)
const _lastHostAccess = new Map();
async function _politeWait(host) {
  const last = _lastHostAccess.get(host) || 0;
  const elapsed = Date.now() - last;
  if (elapsed < POLITE_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, POLITE_INTERVAL_MS - elapsed));
  }
  _lastHostAccess.set(host, Date.now());
}

// In-flight dedup
const _inflight = new Map();

function _doFetch(target, opts = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch (e) { return reject(e); }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(u, { headers: {
      "User-Agent": "KeibaNavigator/0.2 (personal use)",
      "Accept-Language": "ja,en;q=0.5",
      ...(opts.headers || {}),
    }}, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && (opts.redirects || 0) < 5) {
        const next = new URL(res.headers.location, target).href;
        return _doFetch(next, { ...opts, redirects: (opts.redirects || 0) + 1 }).then(resolve, reject);
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
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("timeout")));
  });
}

async function _fetchWithRetry(target, opts, attempt = 0) {
  try {
    const r = await _doFetch(target, opts);
    // リトライ対象: 429 (rate limit) / 5xx
    if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
      if (attempt < RETRY_MAX) {
        const baseMs = 800 * Math.pow(2, attempt);
        const jitter = Math.random() * 400;
        await new Promise(res => setTimeout(res, baseMs + jitter));
        return _fetchWithRetry(target, opts, attempt + 1);
      }
    }
    return r;
  } catch (e) {
    // タイムアウト・ネットワークエラーもリトライ
    if (attempt < RETRY_MAX) {
      const baseMs = 800 * Math.pow(2, attempt);
      const jitter = Math.random() * 400;
      await new Promise(res => setTimeout(res, baseMs + jitter));
      return _fetchWithRetry(target, opts, attempt + 1);
    }
    throw e;
  }
}

function fetchUrl(target, opts = {}) {
  // dedup: 同URLが進行中なら共有
  if (_inflight.has(target)) return _inflight.get(target);

  const promise = (async () => {
    let host = "";
    try { host = new URL(target).host; } catch {}
    await _acquire();
    try {
      if (host) await _politeWait(host);
      return await _fetchWithRetry(target, opts);
    } finally {
      _release();
    }
  })();

  _inflight.set(target, promise);
  promise.then(
    () => { _inflight.delete(target); },
    () => { _inflight.delete(target); },
  );
  return promise;
}

// メモリキャッシュ (TTL指定)
const _cache = new Map();
function getCache(k, ttlMs) {
  const c = _cache.get(k);
  if (c && Date.now() - c.ts < ttlMs) return c.data;
  return null;
}
function setCache(k, data) { _cache.set(k, { ts: Date.now(), data }); }
function clearCache() { _cache.clear(); _inflight.clear(); }

module.exports = {
  fetchUrl, getCache, setCache, clearCache,
  // テスト・デバッグ用
  _config: { MAX_CONCURRENT, POLITE_INTERVAL_MS, RETRY_MAX, TIMEOUT_MS },
};
