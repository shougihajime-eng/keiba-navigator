"use strict";

// KEIBA NAVIGATOR — Service Worker
// 役割:
//   1) 静的アセットのキャッシュ (オフライン起動・ホーム画面アプリ化)
//   2) ローカル通知 (showNotification / notificationclick) のハンドリング
//
// 設計:
//   - /api/* は素通し (キャッシュしない・常に最新)
//   - 静的アセットのみ "cache-first → network fallback"
//   - キャッシュキーをバージョン管理 (古いキャッシュは activate で破棄)

const CACHE_VERSION = "keiba-nav-v18"; // Wave11: 通知細分化 (朝/発走前/WIN5/結果 の 4 種類)
const PRECACHE = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon.svg",
  // ↓静的のうち変更頻度低めのもののみ pre-cache。app.js/styles.css は network-first で別管理
  "/storage.js",
  "/config.js",
];

// network-first で扱う (デプロイ後に古い版が残らないようにする)
const NETWORK_FIRST_PATHS = [
  "/app.js", "/styles.css",
  "/predictors/", "/lib/",
];

function isNetworkFirst(pathname) {
  return NETWORK_FIRST_PATHS.some(p => pathname === p || pathname.startsWith(p));
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_VERSION);
      // 個別に addAll するとどれか1つの 404 で全体失敗するので、個別 add に変更
      await Promise.all(PRECACHE.map(url => cache.add(url).catch(() => null)));
    } catch (e) {
      // インストール失敗してもアプリは動かしたい
    }
  })());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;  // API は素通し

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);

    // network-first 対象 (app.js/styles.css/predictors/lib): 必ずネットを先に試す。
    // ネット失敗時のみキャッシュ。これでデプロイ後の "古い app.js が出続け" を防ぐ。
    if (isNetworkFirst(url.pathname)) {
      try {
        const fresh = await fetch(req, { cache: "no-store" });
        if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => null);
        return fresh;
      } catch {
        const cached = await cache.match(req);
        if (cached) return cached;
        return new Response("offline", { status: 503, statusText: "offline" });
      }
    }

    // それ以外 (index.html, icon 等): cache-first → stale-while-revalidate
    const cached = await cache.match(req);
    if (cached) {
      fetch(req).then(r => { if (r && r.ok) cache.put(req, r.clone()); }).catch(() => null);
      return cached;
    }
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => null);
      return fresh;
    } catch {
      if (req.mode === "navigate") {
        const fallback = await cache.match("/index.html");
        if (fallback) return fallback;
      }
      return new Response("offline", { status: 503, statusText: "offline" });
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of all) {
      if ("focus" in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow("/");
  })());
});

// app.js から postMessage で「今すぐ通知を出して」と指示できるようにする
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "show-notification") {
    self.registration.showNotification(data.title || "KEIBA NAVIGATOR", {
      body: data.body || "",
      icon: "/icon.svg",
      badge: "/icon.svg",
      tag: data.tag || "keiba-nav",
      data: data.payload || {},
    });
  } else if (data.type === "skip-waiting") {
    self.skipWaiting();
  }
});
