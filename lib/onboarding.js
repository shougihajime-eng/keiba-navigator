"use strict";

/*
 * lib/onboarding.js — 初見の人に「触れば分かる」を届ける 4 ステップ ツアー
 *
 * - 起動時に localStorage の `kn_onboarded_v1` を確認
 * - 未完了なら 1 秒後に静かにフェードインで起動
 * - スキップ可・「もう見ない」可・途中で × 可
 * - 各ステップは特定の要素に「光る枠」を当ててガイドを表示
 *
 * 設計の意図:
 * - 主役は「画面上の本物の UI」。モーダルではなく、本物の要素をハイライトする
 * - 非エンジニアでも「これを押せばいい」と分かる、矢印 + 短文
 * - 進めるのは「次へ」だけ。後戻りは不要(短いから)
 */

(function () {
  const LS_KEY = "kn_onboarded_v1";
  const FLAG_DISMISSED = "kn_onboard_dismissed_v1";

  const STEPS = [
    {
      target: ".hero-question",
      title: "ようこそ KEIBA NAVIGATOR へ",
      body: "このアプリは「買うべきか・見送るべきか」を期待値で判定します。<br>長期で <b>回収率100%超</b> を目指す育つ AI です。",
      placement: "below",
    },
    {
      target: "#manual-input-section",
      title: "ここに 1 行ずつ入力",
      body: "オッズ画面を見ながら、<b>1行に1頭</b> ずつ書きます。<br>「📝 サンプルを入れる」で形を見て真似してOK。",
      placement: "below",
    },
    {
      target: "#mi-submit",
      title: "判定ボタン",
      body: "入力できたら <b>「📈 期待値を判定」</b> を押すと、<br>狙える馬・危険な人気馬・穴で面白い馬 が一発で見えます。",
      placement: "above",
    },
    {
      target: "#bottom-tabs",
      title: "記録すると AI が育つ",
      body: "「記録」タブで馬券を残すと、結果から AI が学習し、<br>★1 から ★5「世界クラス」へ成長します。",
      placement: "above",
    },
  ];

  function isDone() {
    try { return localStorage.getItem(LS_KEY) === "done"; } catch { return false; }
  }

  function markDone() {
    try { localStorage.setItem(LS_KEY, "done"); } catch {}
  }

  function shouldRun() {
    if (isDone()) return false;
    try {
      // 「いったん閉じる」を選んだ人は 24 時間は出さない
      const dismissed = Number(localStorage.getItem(FLAG_DISMISSED) || 0);
      if (dismissed && (Date.now() - dismissed) < 24 * 60 * 60 * 1000) return false;
    } catch {}
    // 既に記録が 1 件でもある人は経験者扱い → 起動しない
    try {
      const raw = localStorage.getItem("keiba_nav_v1");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.bets) && parsed.bets.length > 0) return false;
      }
    } catch {}
    return true;
  }

  let _root = null;
  let _idx = 0;
  let _resizeHandler = null;

  function ensureRoot() {
    if (_root && document.body.contains(_root)) return _root;
    const root = document.createElement("div");
    root.className = "kn-ob-root";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.innerHTML = `
      <div class="kn-ob-backdrop"></div>
      <div class="kn-ob-spot" aria-hidden="true"></div>
      <div class="kn-ob-card" role="document">
        <div class="kn-ob-progress" aria-hidden="true">
          <span class="kn-ob-dot" data-i="0"></span>
          <span class="kn-ob-dot" data-i="1"></span>
          <span class="kn-ob-dot" data-i="2"></span>
          <span class="kn-ob-dot" data-i="3"></span>
        </div>
        <div class="kn-ob-title"></div>
        <div class="kn-ob-body"></div>
        <div class="kn-ob-actions">
          <button class="kn-ob-skip" type="button">スキップ</button>
          <button class="kn-ob-next" type="button">次へ →</button>
        </div>
        <button class="kn-ob-close" type="button" aria-label="閉じる">×</button>
      </div>
    `;
    document.body.appendChild(root);
    _root = root;

    root.querySelector(".kn-ob-skip").addEventListener("click", finish);
    root.querySelector(".kn-ob-close").addEventListener("click", () => {
      try { localStorage.setItem(FLAG_DISMISSED, String(Date.now())); } catch {}
      tearDown();
    });
    root.querySelector(".kn-ob-next").addEventListener("click", () => {
      _idx++;
      if (_idx >= STEPS.length) finish();
      else renderStep();
    });
    // Esc で離脱
    document.addEventListener("keydown", onKey);
    // 画面サイズ変化に追従
    _resizeHandler = () => positionStep();
    window.addEventListener("resize", _resizeHandler, { passive: true });
    window.addEventListener("scroll", _resizeHandler, { passive: true });
    return root;
  }

  function onKey(e) {
    if (!_root || _root.hidden) return;
    if (e.key === "Escape") tearDown();
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      _root.querySelector(".kn-ob-next")?.click();
    }
  }

  function renderStep() {
    const step = STEPS[_idx];
    if (!step) { finish(); return; }
    const root = ensureRoot();
    root.querySelector(".kn-ob-title").innerHTML = step.title;
    root.querySelector(".kn-ob-body").innerHTML = step.body;
    const next = root.querySelector(".kn-ob-next");
    next.textContent = (_idx >= STEPS.length - 1) ? "始める ✓" : "次へ →";
    root.querySelectorAll(".kn-ob-dot").forEach((d, i) => {
      d.classList.toggle("active",  i === _idx);
      d.classList.toggle("done",    i <  _idx);
    });
    positionStep();
  }

  function positionStep() {
    if (!_root) return;
    const step = STEPS[_idx];
    if (!step) return;
    const target = document.querySelector(step.target);
    const spot = _root.querySelector(".kn-ob-spot");
    const card = _root.querySelector(".kn-ob-card");
    if (!target) {
      // 対象が無ければスポットを隠して中央配置
      spot.style.display = "none";
      card.style.left = "50%";
      card.style.top = "50%";
      card.style.transform = "translate(-50%, -50%)";
      return;
    }
    spot.style.display = "";
    const r = target.getBoundingClientRect();
    const padding = 10;
    spot.style.left   = (r.left  - padding) + "px";
    spot.style.top    = (r.top   - padding) + "px";
    spot.style.width  = (r.width + padding * 2) + "px";
    spot.style.height = (r.height + padding * 2) + "px";

    // カード位置: target の上 or 下
    const cardRect = card.getBoundingClientRect();
    const cw = cardRect.width  || 320;
    const ch = cardRect.height || 200;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let placement = step.placement || "below";
    const spaceBelow = vh - r.bottom;
    const spaceAbove = r.top;
    if (placement === "below" && spaceBelow < ch + 24 && spaceAbove > ch + 24) placement = "above";
    if (placement === "above" && spaceAbove < ch + 24 && spaceBelow > ch + 24) placement = "below";

    let left = r.left + r.width / 2 - cw / 2;
    left = Math.max(12, Math.min(vw - cw - 12, left));
    let top;
    if (placement === "above") top = Math.max(12, r.top - ch - 16);
    else top = Math.min(vh - ch - 12, r.bottom + 16);

    card.style.left = left + "px";
    card.style.top  = top + "px";
    card.style.transform = "";
  }

  function finish() {
    markDone();
    tearDown();
  }

  function tearDown() {
    if (_root) {
      _root.classList.add("kn-ob-leaving");
      setTimeout(() => {
        if (_root && _root.parentNode) _root.parentNode.removeChild(_root);
        _root = null;
      }, 200);
    }
    document.removeEventListener("keydown", onKey);
    if (_resizeHandler) {
      window.removeEventListener("resize", _resizeHandler);
      window.removeEventListener("scroll", _resizeHandler);
      _resizeHandler = null;
    }
  }

  function start() {
    _idx = 0;
    ensureRoot();
    renderStep();
  }

  // 起動: shouldRun が真なら 800ms 後にフェードイン
  function autoStart() {
    if (!shouldRun()) return;
    setTimeout(start, 800);
  }

  // 公開API: 手動で再起動できる(設定タブから)
  window.KNOnboarding = {
    start: () => { _idx = 0; ensureRoot(); renderStep(); },
    reset: () => { try { localStorage.removeItem(LS_KEY); localStorage.removeItem(FLAG_DISMISSED); } catch {} },
    isDone,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoStart, { once: true });
  } else {
    autoStart();
  }
})();
