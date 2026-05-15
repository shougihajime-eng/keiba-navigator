"use strict";
/* ═══════════════════════════════════════════════════════════
   KEIBA NAVIGATOR — Tactile (Wave 9)
   ───────────────────────────────────────────────────────────
   全アプリ共通の触覚レイヤー。すべて自動適用される (個別 wiring 不要)。
     - Ripple    : ボタン/サマリーへの押下波紋 (Material flavor)
     - Magnet    : デスクトップで主要ボタンが pointer に追従
     - Haptic    : navigator.vibrate でパターン分け
     - LongPress : data-longpress カードの長押し拡大 + バイブ
     - Tab pill  : ボトムタブの active を流体ピルでモーフィング
     - Spring    : クリック時の弾性圧縮 (CSS だけでは出ない肌触り)
     - Theme     : スクロール深度に応じて theme-color を滑らかに変える
   reduced-motion / coarse pointer / 低スペックを尊重。
   ═══════════════════════════════════════════════════════════ */
(function () {
  if (typeof window === "undefined") return;
  const doc = document;

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarse       = matchMedia("(pointer: coarse)").matches;
  const hover        = matchMedia("(hover: hover)").matches;

  /* ─── Haptic patterns ─── */
  const VIB = {
    tap:     8,
    select:  [12],
    success: [14, 50, 28],
    error:   [60, 40, 60],
    longp:   [4, 24, 10],
    confirm: [22],
  };
  function vibrate(kind) {
    try { navigator.vibrate?.(VIB[kind] ?? kind); } catch {}
  }
  window.tactile = Object.freeze({
    tap:     () => vibrate("tap"),
    select:  () => vibrate("select"),
    success: () => vibrate("success"),
    error:   () => vibrate("error"),
    longp:   () => vibrate("longp"),
    confirm: () => vibrate("confirm"),
  });

  /* ─── Ripple ─── */
  const RIPPLE_SEL = [
    "button:not([disabled]):not(.tact-no-ripple)",
    "[role=tab]",
    "summary",
    ".bt-btn", ".btn-rec", ".btn-refresh", ".mi-submit",
    ".mi-quickbtn", ".rec-tab", ".strategy-btn", ".period-pill",
    ".rk-tab", ".aff-tab", ".faq-q", ".pro-summary",
    ".sr-load", ".btn-info-outline", ".btn-danger-outline",
    "[data-tactile]"
  ].join(",");

  function spawnRipple(host, clientX, clientY) {
    if (reduceMotion) return;
    const rect = host.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = (clientX ?? rect.left + rect.width / 2) - rect.left;
    const y = (clientY ?? rect.top  + rect.height / 2) - rect.top;
    const size = Math.hypot(
      Math.max(x, rect.width - x),
      Math.max(y, rect.height - y)
    ) * 2;
    const rip = doc.createElement("span");
    rip.className = "tact-ripple";
    rip.style.left   = (x - size / 2) + "px";
    rip.style.top    = (y - size / 2) + "px";
    rip.style.width  = size + "px";
    rip.style.height = size + "px";
    // host が overflow: visible だと波紋がはみ出す → 一時的に隠す
    const cs = getComputedStyle(host);
    if (cs.position === "static") host.dataset.tactPos = "1", host.style.position = "relative";
    if (cs.overflow === "visible") host.dataset.tactOf = "1", host.style.overflow = "hidden";
    host.appendChild(rip);
    rip.addEventListener("animationend", () => rip.remove(), { once: true });
    setTimeout(() => rip.remove(), 900);
  }

  doc.addEventListener("pointerdown", (e) => {
    const host = e.target.closest?.(RIPPLE_SEL);
    if (!host || host.disabled) return;
    spawnRipple(host, e.clientX, e.clientY);
    if (e.pointerType === "touch") vibrate("tap");
  }, { passive: true });

  // キーボードEnter で押された時も波紋を出す
  doc.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const host = doc.activeElement;
    if (!host || !host.matches?.(RIPPLE_SEL) || host.disabled) return;
    spawnRipple(host);
  });

  /* ─── Magnetic hover (desktop only) ─── */
  if (hover && !coarse && !reduceMotion) {
    const MAG_SEL = ".btn-refresh,.mi-submit,.btn-rec,.strategy-btn,[data-magnetic]";
    let active = null;
    const reset = (el) => { if (el) el.style.transform = ""; };
    doc.addEventListener("pointermove", (e) => {
      const el = e.target.closest?.(MAG_SEL);
      if (active && active !== el) { reset(active); active = null; }
      if (!el || el.disabled) return;
      active = el;
      const r = el.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width  / 2)) / r.width;
      const dy = (e.clientY - (r.top  + r.height / 2)) / r.height;
      // 軽い磁力 (4px 上限)
      el.style.transform = `translate(${(dx * 4).toFixed(2)}px, ${(dy * 4).toFixed(2)}px)`;
    }, { passive: true });
    doc.addEventListener("pointerleave", () => { reset(active); active = null; }, { passive: true });
    doc.addEventListener("pointerdown",  () => { reset(active); active = null; }, { passive: true });
  }

  /* ─── Long-press preview ─── */
  let lpTimer = null;
  let lpEl = null;
  function clearLP() {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
    if (lpEl) { lpEl.classList.remove("is-longpressed"); lpEl = null; }
  }
  doc.addEventListener("pointerdown", (e) => {
    const card = e.target.closest?.("[data-longpress]");
    if (!card) return;
    lpEl = card;
    lpTimer = setTimeout(() => {
      card.classList.add("is-longpressed");
      vibrate("longp");
      lpTimer = null;
    }, 260);
  }, { passive: true });
  ["pointerup", "pointercancel", "pointerleave", "scroll"].forEach((evt) =>
    doc.addEventListener(evt, clearLP, { passive: true, capture: true })
  );

  /* ─── Bottom-tab fluid pill indicator ─── */
  function setupTabPill() {
    const nav = doc.querySelector(".bottom-tabs");
    if (!nav) return;
    const pill = doc.createElement("span");
    pill.className = "bt-pill";
    pill.setAttribute("aria-hidden", "true");
    nav.appendChild(pill);

    function place(target, animate) {
      if (!target) return;
      const navRect = nav.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      const cx = r.left - navRect.left + r.width / 2;
      pill.style.setProperty("--pill-x", cx + "px");
      pill.style.setProperty("--pill-w", Math.min(r.width - 24, 56) + "px");
      pill.dataset.ready = "1";
      if (animate) pill.classList.add("is-moving");
      clearTimeout(place._t);
      place._t = setTimeout(() => pill.classList.remove("is-moving"), 280);
    }

    function current() { return nav.querySelector(".bt-btn.active"); }
    requestAnimationFrame(() => place(current(), false));

    // タブ切替はクリックで観測 (active クラス付与は既存ロジックに任せる)
    nav.addEventListener("click", (e) => {
      const btn = e.target.closest?.(".bt-btn");
      if (!btn) return;
      // active 付与は app.js が直後に行う → 次フレームで反映
      requestAnimationFrame(() => place(current(), true));
    });

    // window resize / 向き変更
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => place(current(), false), 120);
    }, { passive: true });

    // MutationObserver で外部からの active 変更にも追従
    const mo = new MutationObserver(() => place(current(), true));
    nav.querySelectorAll(".bt-btn").forEach((b) =>
      mo.observe(b, { attributes: true, attributeFilter: ["class"] })
    );
  }

  /* ─── Theme color on scroll (subtle depth feedback) ─── */
  function setupThemeColor() {
    const meta = doc.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    let scrolled = false;
    let rafId = null;
    function update() {
      rafId = null;
      const y = window.scrollY || 0;
      const s = y > 12;
      if (s !== scrolled) {
        scrolled = s;
        meta.setAttribute("content", s ? "#070b16" : "#0a0e1a");
      }
    }
    window.addEventListener("scroll", () => {
      if (rafId == null) rafId = requestAnimationFrame(update);
    }, { passive: true });
  }

  /* ─── 起動 ─── */
  function boot() {
    setupTabPill();
    setupThemeColor();
    // iOS で要素全体に長押しメニュー出ないように (画像は除外)
    doc.documentElement.style.setProperty("-webkit-touch-callout", "none");
  }
  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
