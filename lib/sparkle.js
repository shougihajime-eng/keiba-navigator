"use strict";
/* ═══════════════════════════════════════════════════════════
   KEIBA NAVIGATOR — Sparkle (Wave 9)
   ───────────────────────────────────────────────────────────
   GPU 軽量な粒子演出 (DOM要素 × CSS animation・Canvas 不要)。
   呼び出し:
     window.kbSparkle.burstFrom(element, { count, hue, intensity })
     window.kbSparkle.burstAt(x, y, opts)
     window.kbSparkle.successOn(element)
     window.kbSparkle.unlockOn(element)
   reduced-motion は自動 no-op。
   ═══════════════════════════════════════════════════════════ */
(function () {
  if (typeof window === "undefined") return;
  const doc = document;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let layer = null;
  function ensureLayer() {
    if (layer) return layer;
    layer = doc.createElement("div");
    layer.className = "kb-sparkle-layer";
    layer.setAttribute("aria-hidden", "true");
    doc.body.appendChild(layer);
    return layer;
  }

  function spawnParticle(x, y, opts) {
    const { hue = 152, life = 900, dist = 60, size = 6 } = opts;
    const p = doc.createElement("span");
    p.className = "kb-sparkle";
    const angle = Math.random() * Math.PI * 2;
    const r = dist * (0.55 + Math.random() * 0.7);
    const dx = Math.cos(angle) * r;
    const dy = Math.sin(angle) * r - (Math.random() * 18); // 少し上に飛ぶ
    const rot = (Math.random() - 0.5) * 280;
    p.style.setProperty("--sp-x", dx.toFixed(1) + "px");
    p.style.setProperty("--sp-y", dy.toFixed(1) + "px");
    p.style.setProperty("--sp-r", rot.toFixed(0) + "deg");
    p.style.setProperty("--sp-h", hue);
    p.style.setProperty("--sp-l", (62 + Math.random() * 18).toFixed(0) + "%");
    p.style.setProperty("--sp-size", size.toFixed(1) + "px");
    p.style.left = x + "px";
    p.style.top  = y + "px";
    p.style.animationDuration = life + "ms";
    ensureLayer().appendChild(p);
    p.addEventListener("animationend", () => p.remove(), { once: true });
    setTimeout(() => p.remove(), life + 200);
  }

  function burstAt(x, y, opts = {}) {
    if (reduce) return;
    const { count = 14, hue = 152, intensity = 1 } = opts;
    const c = Math.max(4, Math.round(count * intensity));
    for (let i = 0; i < c; i++) {
      spawnParticle(x, y, {
        hue,
        life: 760 + Math.random() * 380,
        dist: 50 + Math.random() * 70 * intensity,
        size: 4 + Math.random() * 5,
      });
    }
  }

  function burstFrom(el, opts = {}) {
    if (!el || reduce) return;
    const r = el.getBoundingClientRect?.();
    if (!r) return;
    burstAt(r.left + r.width / 2, r.top + r.height / 2, opts);
  }

  window.kbSparkle = Object.freeze({
    burstAt,
    burstFrom,
    successOn:  (el) => burstFrom(el, { count: 18, hue: 152, intensity: 1.0 }),
    moneyOn:    (el) => burstFrom(el, { count: 22, hue: 44,  intensity: 1.1 }),
    underOn:    (el) => burstFrom(el, { count: 16, hue: 280, intensity: 0.9 }),
    unlockOn:   (el) => burstFrom(el, { count: 28, hue: 36,  intensity: 1.3 }),
  });
})();
