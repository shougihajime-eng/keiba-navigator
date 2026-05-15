"use strict";

/*
 * lib/animate.js — 数字のスムーズアニメーション + 軽量な微演出
 *
 * - animateNumber(el, from, to, opts) — 数値を視覚的に補間
 * - 「いきなり 1234 が出る」より「0 → 1234 へなめらかに増える」方が驚き × 信頼感
 * - reduced-motion の人は即値で表示 (a11y)
 */

(function () {
  if (typeof window === "undefined") return;

  const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  /**
   * 数値を from から to に補間して要素テキストを更新
   * @param {HTMLElement} el
   * @param {number} from
   * @param {number} to
   * @param {Object} opts - { duration: 800, format: (n)=>str, suffix: "", prefix: "" }
   */
  function animateNumber(el, from, to, opts = {}) {
    if (!el) return;
    const duration = opts.duration ?? 800;
    const format = opts.format || ((n) => String(Math.round(n)));
    const prefix = opts.prefix || "";
    const suffix = opts.suffix || "";

    if (reducedMotion() || duration <= 0) {
      el.textContent = prefix + format(to) + suffix;
      return;
    }

    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      el.textContent = prefix + format(to) + suffix;
      return;
    }

    if (el._knAnimRaf) cancelAnimationFrame(el._knAnimRaf);
    const start = performance.now();
    const delta = to - from;
    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = easeOutCubic(t);
      const cur = from + delta * eased;
      el.textContent = prefix + format(cur) + suffix;
      if (t < 1) el._knAnimRaf = requestAnimationFrame(frame);
      else el._knAnimRaf = null;
    }
    el._knAnimRaf = requestAnimationFrame(frame);
  }

  // 「データ属性で発火」: <span data-anim-to="1234"> のような書き方は使わず、
  // 既存の renderer から明示的に呼んでもらう形にした方が制御しやすい

  /**
   * スタガー fade-in: 兄弟要素を順次浮上させる軽演出
   * 通常は CSS の :first-of-type 等で対応した方がいいが、JS で発火する方がタイミングを揃えやすい
   */
  function staggerIn(elements, delayStep = 60) {
    if (reducedMotion()) return;
    [...elements].forEach((el, i) => {
      if (!el) return;
      el.style.opacity = "0";
      el.style.transform = "translateY(8px)";
      el.style.transition = `opacity 280ms cubic-bezier(.2,.7,.2,1), transform 280ms cubic-bezier(.2,.7,.2,1)`;
      setTimeout(() => {
        el.style.opacity = "1";
        el.style.transform = "translateY(0)";
        // クリーンアップ: 完了したら inline style を消す
        setTimeout(() => {
          el.style.opacity = ""; el.style.transform = ""; el.style.transition = "";
        }, 400);
      }, i * delayStep);
    });
  }

  // pick-num / pick-stake-amount などの「主役な数字」がテキスト変更されたら
  // ふわっとフェード切替で出す (大量の MutationObserver は避けて、明示的に呼ぶ形にも対応)
  function flashHighlight(el) {
    if (!el || reducedMotion()) return;
    el.classList.remove("kn-flash");
    void el.offsetWidth;  // reflow trigger
    el.classList.add("kn-flash");
    setTimeout(() => el.classList.remove("kn-flash"), 700);
  }

  /**
   * 小さな折れ線スパークライン (HiDPI 対応・色は trend に応じて変える)
   * @param {HTMLCanvasElement} canvas
   * @param {number[]} values  数値の配列。短い (typically <= 30) ものを想定
   * @param {Object} opts  { positive: number=1.0, color: "" }
   */
  function drawSparkline(canvas, values, opts = {}) {
    if (!canvas) return;
    if (!Array.isArray(values) || values.length < 2) {
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth  || canvas.width  || 80;
    const H = canvas.clientHeight || canvas.height || 24;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr; canvas.height = H * dpr;
      canvas.style.width = W + "px"; canvas.style.height = H + "px";
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = (max - min) || 1;
    const padding = 2;
    const sx = (W - padding * 2) / (values.length - 1);
    const sy = (v) => H - padding - ((v - min) / range) * (H - padding * 2);

    const last = values[values.length - 1];
    const positive = opts.positive != null ? opts.positive : 1.0;
    const color = opts.color || (last >= positive ? "#34d399" : "#f87171");

    // 透明グラデの塗り
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, color + "55");
    grad.addColorStop(1, color + "00");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(padding, H);
    values.forEach((v, i) => ctx.lineTo(padding + i * sx, sy(v)));
    ctx.lineTo(padding + (values.length - 1) * sx, H);
    ctx.closePath();
    ctx.fill();

    // 線
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = padding + i * sx;
      const y = sy(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 末尾ドット
    const lx = padding + (values.length - 1) * sx;
    const ly = sy(last);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(lx, ly, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(10,14,26,1)";
    ctx.lineWidth = 1; ctx.stroke();
  }

  window.KNAnim = {
    animateNumber,
    staggerIn,
    flashHighlight,
    drawSparkline,
  };
})();
