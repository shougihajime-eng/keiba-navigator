/* =====================================================================
   KEIBA NAVIGATOR — effects.js  (Wave22.8)
   役割:
     1) Web Audio で「蹄音 (カポッカポッ)」を JS だけで生成 (ファイル不要)
     2) Canvas で派手な紙吹雪 (的中時)
     3) 「もうすぐ発走」「発走!」フルスクリーンフラッシュ
     4) 効果音 ON/OFF をユーザー設定で管理
   ===================================================================== */
(function () {
  "use strict";

  const prefersReduce =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const SOUND_KEY = "keiba_sound_off";

  function isSoundOff() {
    try { return localStorage.getItem(SOUND_KEY) === "1"; } catch { return false; }
  }
  function setSoundOff(off) {
    try { localStorage.setItem(SOUND_KEY, off ? "1" : "0"); } catch {}
  }

  // ─── Web Audio 蹄音 ────────────────────────────────────────
  let _ac = null;
  function audio() {
    if (_ac) return _ac;
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    try { _ac = new C(); } catch { _ac = null; }
    return _ac;
  }

  // 単発のクロップ音 (低い「カポッ」)
  function _clop(ctx, when, baseFreq, vol) {
    // ノイズで打撃感 + サイン波で胴体共鳴
    const dur = 0.13;
    // 1) ノイズバースト
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const env = Math.exp(-i / (ctx.sampleRate * 0.02));
      data[i] = (Math.random() * 2 - 1) * env;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.10 * vol;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1200;
    bp.Q.value = 4;
    noise.connect(bp); bp.connect(noiseGain); noiseGain.connect(ctx.destination);
    noise.start(when);
    noise.stop(when + dur);

    // 2) 共鳴トーン (三角波で柔らかく)
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(baseFreq, when);
    o.frequency.exponentialRampToValueAtTime(baseFreq * 0.45, when + 0.10);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, when);
    g.gain.exponentialRampToValueAtTime(0.18 * vol, when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.13);
    o.connect(g); g.connect(ctx.destination);
    o.start(when);
    o.stop(when + 0.14);
  }

  function playHoofClop() {
    if (prefersReduce || isSoundOff()) return;
    const ctx = audio();
    if (!ctx) return;
    if (ctx.state === "suspended") { ctx.resume().catch(() => {}); }
    const t = ctx.currentTime;
    // 4 拍の蹄音 (高-低-高-低)
    _clop(ctx, t + 0.00, 360, 1.0);
    _clop(ctx, t + 0.13, 240, 0.85);
    _clop(ctx, t + 0.26, 350, 0.95);
    _clop(ctx, t + 0.39, 230, 0.80);
  }

  // 発走の合図 (より高い音・3 連)
  function playStartSignal() {
    if (prefersReduce || isSoundOff()) return;
    const ctx = audio();
    if (!ctx) return;
    if (ctx.state === "suspended") { ctx.resume().catch(() => {}); }
    const t = ctx.currentTime;
    const beep = (when, freq) => {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, when);
      g.gain.exponentialRampToValueAtTime(0.25, when + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.18);
      o.connect(g); g.connect(ctx.destination);
      o.start(when); o.stop(when + 0.20);
    };
    beep(t + 0.00, 880);
    beep(t + 0.15, 880);
    beep(t + 0.30, 1320);
  }

  // 的中時の歓声系効果音 (ファンファーレ風 3 音)
  function playWinFanfare() {
    if (prefersReduce || isSoundOff()) return;
    const ctx = audio();
    if (!ctx) return;
    if (ctx.state === "suspended") { ctx.resume().catch(() => {}); }
    const t = ctx.currentTime;
    const note = (when, freq, dur) => {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, when);
      g.gain.exponentialRampToValueAtTime(0.22, when + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, when + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(when); o.stop(when + dur + 0.02);
    };
    note(t + 0.00, 523.25, 0.20);  // C5
    note(t + 0.16, 659.25, 0.20);  // E5
    note(t + 0.32, 783.99, 0.40);  // G5
  }

  // ─── Canvas 紙吹雪 ─────────────────────────────────────────
  function fireConfetti(opts = {}) {
    if (prefersReduce) return;
    const dur = opts.duration || 3500;
    const colors = opts.colors || ["#E4C77E", "#C9A85C", "#F0D9A6", "#FFFFFF", "#9C7E3A", "#F1EFEA"];
    const count = opts.count || 100;

    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:9999;width:100vw;height:100vh";
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width  = w * dpr;
    canvas.height = h * dpr;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) { canvas.remove(); return; }
    ctx.scale(dpr, dpr);

    // 2 拠点 (左下 + 右下) から発射
    const particles = [];
    for (let i = 0; i < count; i++) {
      const left = i % 2 === 0;
      particles.push({
        x: left ? 0 : w,
        y: h * 0.62 + Math.random() * 30,
        vx: (Math.random() * 6 + 5) * (left ? 1 : -1),
        vy: -(Math.random() * 14 + 9),
        g:  0.32,
        size: Math.random() * 7 + 5,
        color: colors[Math.floor(Math.random() * colors.length)],
        rot: Math.random() * Math.PI,
        vrot: (Math.random() - 0.5) * 0.40,
        shape: Math.random() < 0.6 ? "rect" : "circle",
        alpha: 1.0,
      });
    }

    const start = performance.now();
    function step(t) {
      const elapsed = t - start;
      ctx.clearRect(0, 0, w, h);
      particles.forEach(p => {
        p.vy += p.g;
        p.vx *= 0.99;
        p.x  += p.vx;
        p.y  += p.vy;
        p.rot += p.vrot;
        p.alpha = Math.max(0, 1 - elapsed / dur);

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.alpha;
        if (p.shape === "rect") {
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.5);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      });
      if (elapsed < dur) {
        requestAnimationFrame(step);
      } else {
        canvas.remove();
      }
    }
    requestAnimationFrame(step);
  }

  // ─── 「もうすぐ発走」「発走!」フルスクリーンフラッシュ ───
  function flashImminent(msg) {
    if (prefersReduce) return;
    if (document.querySelector(".imminent-flash")) return;  // 多重起動防止
    const overlay = document.createElement("div");
    overlay.className = "imminent-flash";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
      <div class="if-bg"></div>
      <div class="if-content">
        <div class="if-emoji">⚡</div>
        <div class="if-text">${msg || "もうすぐ発走!"}</div>
      </div>
    `;
    document.body.appendChild(overlay);
    setTimeout(() => overlay.classList.add("if-in"), 10);
    setTimeout(() => { overlay.classList.add("if-out"); }, 1300);
    setTimeout(() => overlay.remove(), 1900);
  }

  function flashStart(msg) {
    if (prefersReduce) return;
    if (document.querySelector(".start-flash")) return;
    const overlay = document.createElement("div");
    overlay.className = "start-flash";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
      <div class="sf-bg"></div>
      <div class="sf-content">
        <div class="sf-text">${msg || "発 走 !"}</div>
        <div class="sf-sub">スタートの合図が鳴りました</div>
      </div>
    `;
    document.body.appendChild(overlay);
    setTimeout(() => overlay.classList.add("sf-in"), 10);
    setTimeout(() => { overlay.classList.add("sf-out"); }, 1500);
    setTimeout(() => overlay.remove(), 2200);
    playStartSignal();
  }

  // ─── トースト + 確認用 effects 一覧 ──────────────────────
  // 外部からテスト用に呼び出せるよう window に export
  window.kbEffects = {
    playHoofClop,
    playStartSignal,
    playWinFanfare,
    fireConfetti,
    flashImminent,
    flashStart,
    isSoundOff,
    setSoundOff,
  };
})();
