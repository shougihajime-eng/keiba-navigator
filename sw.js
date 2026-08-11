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

const CACHE_VERSION = "keiba-nav-v84"; // 本命の答え合わせを発走前オッズの本物に差し替え (8/12)
const PRECACHE = [
  "/manifest.json",
  "/icon.svg",
  "/assets/horse-bg.jpg",
  // ↓ /, /index.html は network-only に変更したので pre-cache から外す
  //   (オフライン時のフォールバックは /offline.html を別途返す)
];

// network-first のネット待ち上限 (ms)。遅い回線ではこれを超えたら
// 手元のキャッシュで即表示し、ネットの結果は裏でキャッシュ更新に回す。
// 鮮度: 次回ロードでは更新済みキャッシュ or 速いネットが返る。
const NETWORK_TIMEOUT_MS = 2500;

// network-first で扱う (デプロイ後に古い版が残らないようにする)
// 【!】index.html を cache-first にしておくと、新デプロイで JS チャンクのハッシュが
//     変わったときに、古いHTMLが古いチャンクURLを参照して 404 → ChunkLoadError 多発。
//     必殺１ごうてい(競艇)で実際に起きた事故 (Bug ⑧)。
//     → HTML は **network-only** に格下げ。offline 時のみ最小フォールバック。
const NETWORK_FIRST_PATHS = [
  "/app.js", "/styles.css",
  // 2026-08-11 追加: styles.polish.css を入れ忘れると cache-first になり、
  //   見やすさを直しても古い見た目が残る (本人がいちばん嫌う事故)。
  //   ⚠ startsWith 判定なので "/styles.css" では polish 版に当たらない。必ず別に書く。
  "/styles.polish.css",
  "/predictors/", "/lib/",
];

// HTML系は network-only (キャッシュしない・古いHTMLが残らない)
function isHtmlNavigation(req, url) {
  if (req.mode === "navigate") return true;
  const accept = req.headers.get("accept") || "";
  if (accept.includes("text/html")) return true;
  if (url.pathname === "/" || url.pathname.endsWith(".html")) return true;
  return false;
}

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

    // ★ HTML navigation は network-only。デプロイ直後の古いHTML残留=ChunkLoadError 根治。
    //   オフライン時のみ簡易フォールバックを返す。
    if (isHtmlNavigation(req, url)) {
      try {
        const fresh = await fetch(req, { cache: "no-store" });
        return fresh;
      } catch {
        return new Response(
          "<!doctype html><meta charset=utf-8><title>オフライン</title>" +
          "<body style='font-family:sans-serif;padding:24px;text-align:center;background:#0a0a0a;color:#eee'>" +
          "<h1 style='color:#ffd166'>📡 通信が一瞬切れています</h1>" +
          "<p>つながったら自動で開きます</p>" +
          "<script>setInterval(()=>fetch('/').then(r=>r.ok&&location.replace('/')).catch(()=>0),3000)</script>",
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
    }

    // network-first 対象 (app.js/styles.css/predictors/lib): 必ずネットを先に試す。
    // ただし NETWORK_TIMEOUT_MS を超えたらキャッシュで即表示 (遅い回線対策)。
    // ネットの結果は裏で待ち続けてキャッシュを更新するので、次回は最新になる。
    if (isNetworkFirst(url.pathname)) {
      const networkPromise = fetch(req, { cache: "no-store" }).then((fresh) => {
        if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => null);
        return fresh;
      });
      // 後で使わない場合の unhandled rejection を防ぐ
      networkPromise.catch(() => null);
      const timeoutToken = Symbol("timeout");
      const winner = await Promise.race([
        networkPromise.catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(timeoutToken), NETWORK_TIMEOUT_MS)),
      ]);
      if (winner && winner !== timeoutToken) return winner;  // ネットが先に返った (成功)
      const cached = await cache.match(req);
      if (cached) return cached;                              // 遅い/失敗 → キャッシュで即表示
      try {
        const fresh = await networkPromise;                   // キャッシュも無い → ネットを待ち切る
        if (fresh) return fresh;
      } catch { /* fallthrough */ }
      return new Response("offline", { status: 503, statusText: "offline" });
    }

    // それ以外 (icon 等の静的アセット): cache-first → stale-while-revalidate
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
