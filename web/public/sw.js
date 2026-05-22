// KEIBA NAVIGATOR Service Worker
// Strategy:
//  - HTML / Next chunks: network-first, fallback to cache (古い chunk による白画面回避)
//  - 静的アセット: cache-first
//  - /api/*: network-only (キャッシュ汚染を避ける・常に最新)

const CACHE_VERSION = "keiba-v2-2026-05-23-01";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const PRECACHE = [
  "/",
  "/manifest.webmanifest",
  "/icon-192.svg",
  "/icon-512.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      cache.addAll(PRECACHE).catch(() => null),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // API は SW を通さず常に network
  if (url.pathname.startsWith("/api/")) return;

  // 外部オリジン (Google Fonts 等) は network-first + キャッシュ
  if (url.origin !== self.location.origin) {
    event.respondWith(networkFirst(req));
    return;
  }

  // HTML / Next.js chunk → network-first
  if (req.mode === "navigate" || url.pathname.startsWith("/_next/")) {
    event.respondWith(networkFirst(req));
    return;
  }

  // その他 (静的アセット) → cache-first
  event.respondWith(cacheFirst(req));
});

async function networkFirst(req) {
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    if (req.mode === "navigate") {
      const fallback = await caches.match("/");
      if (fallback) return fallback;
    }
    throw new Error("offline");
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch {
    if (cached) return cached;
    throw new Error("offline");
  }
}

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});
