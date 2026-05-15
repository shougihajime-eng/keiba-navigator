"use strict";

/*
 * lib/ai_voice.js — AI コーチが結論を読み上げる (Web Speech Synthesis API)
 *
 * - スピーカーボタンタップで結論カードを読み上げ
 * - 日本語ボイスを優先 (なければデフォルト)
 * - 設定で完全 OFF にできる (デフォルトは OFF・明示的同意を尊重)
 * - 「もう一度」で再生・「停止」で中断
 */

(function () {
  const synth = window.speechSynthesis;
  const SUPPORTED = !!synth;
  const LS_KEY = "kn_ai_voice_enabled_v1";

  function isEnabled() {
    try { return localStorage.getItem(LS_KEY) === "1"; } catch { return false; }
  }
  function setEnabled(b) {
    try { localStorage.setItem(LS_KEY, b ? "1" : "0"); } catch {}
  }

  function pickJaVoice() {
    if (!SUPPORTED) return null;
    const voices = synth.getVoices() || [];
    if (!voices.length) return null;
    // 優先順:
    // 1. ja-JP の Google or Microsoft (高品質)
    // 2. ja-JP のどれか
    // 3. ja で始まるどれか
    const ja = voices.filter(v => v.lang === "ja-JP" || v.lang?.startsWith("ja"));
    const pref = ja.find(v => /google|microsoft|natural/i.test(v.name)) || ja[0];
    return pref || null;
  }

  function speak(text, opts = {}) {
    if (!SUPPORTED || !text) return;
    cancel();
    try {
      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = "ja-JP";
      u.rate = opts.rate ?? 1.05;
      u.pitch = opts.pitch ?? 1.0;
      u.volume = opts.volume ?? 1.0;
      const v = pickJaVoice();
      if (v) u.voice = v;
      synth.speak(u);
      return u;
    } catch (e) {
      console.warn("[ai_voice] speak failed", e);
    }
  }

  function cancel() {
    if (!SUPPORTED) return;
    try { synth.cancel(); } catch {}
  }

  // ─── 結論カードから読み上げる文を組み立てる ─────────────────
  function composeVerdictSpeech() {
    const titleEl  = document.getElementById("bv-title");
    const reasonEl = document.getElementById("bv-reason");
    const gradeEl  = document.getElementById("bv-grade");
    const labelEl  = document.getElementById("bv-stars-label");
    const pickName = document.getElementById("pick-name");
    const pickNum  = document.getElementById("pick-num");
    const pickReason = document.getElementById("pick-reason");

    const title = (titleEl?.textContent || "").trim();
    const reason = (reasonEl?.textContent || "").trim();
    const grade = gradeEl && !gradeEl.hidden ? (gradeEl.textContent || "").trim() : "";
    const stars = (labelEl?.textContent || "").trim();
    const pName = (pickName?.textContent || "").trim();
    const pNum  = (pickNum?.textContent || "").trim();
    const pReason = (pickReason?.textContent || "").trim();

    const parts = [];
    if (title) parts.push("結論。" + title);
    if (grade && !/^--$/.test(grade)) parts.push("グレードは " + grade + "。");
    if (stars && !/^--$/.test(stars)) parts.push("信頼度は " + stars + "。");
    if (pName && !/^--$/.test(pName) && pNum && !/^--$/.test(pNum)) {
      parts.push(`狙うなら ${pNum} 番、${pName}。`);
    }
    if (pReason && !/^--$/.test(pReason)) parts.push(pReason);
    else if (reason) parts.push(reason);
    return parts.join(" ");
  }

  function speakVerdict() {
    const text = composeVerdictSpeech();
    if (!text) return;
    speak(text);
  }

  // ─── ボタン UI ──────────────────────────────────────────
  // 結論カードに 🔊 ボタンを差し込む
  function installSpeakerButton() {
    if (!SUPPORTED) return;
    const card = document.getElementById("big-verdict");
    if (!card) return;
    if (card.querySelector(".kn-aiv-btn")) return; // 既に挿入済

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kn-aiv-btn";
    btn.setAttribute("aria-label", "結論を読み上げる");
    btn.title = "結論を読み上げる";
    btn.innerHTML = "🔊";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      // 1 タップ目で許可を取り、設定 ON、即読み上げ
      if (!isEnabled()) setEnabled(true);
      if (synth?.speaking) { cancel(); btn.classList.remove("speaking"); return; }
      btn.classList.add("speaking");
      const u = speakVerdict();
      if (u) {
        u.onend = () => btn.classList.remove("speaking");
        u.onerror = () => btn.classList.remove("speaking");
      } else {
        btn.classList.remove("speaking");
      }
    });
    card.appendChild(btn);
  }

  // 結論変化を検知して、ONなら自動読み上げ (体験は控えめにするため初期OFF)
  // 設定タブで明示 ON にした人だけが自動再生対象
  function watchVerdictChanges() {
    const title = document.getElementById("bv-title");
    if (!title) return;
    const mo = new MutationObserver(() => {
      if (!isEnabled()) return;
      // 連射防止: 直前の発話を上書き
      try { speakVerdict(); } catch {}
    });
    mo.observe(title, { childList: true, characterData: true, subtree: true });
  }

  // ボイス一覧の lazy 読み込み (Chrome 系は voiceschanged で初めて配列が埋まる)
  if (SUPPORTED && synth.onvoiceschanged !== undefined) {
    synth.onvoiceschanged = () => { /* keep around for late-binding */ };
  }

  function init() {
    installSpeakerButton();
    watchVerdictChanges();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  window.KNAiVoice = {
    supported: SUPPORTED,
    speak,
    cancel,
    speakVerdict,
    isEnabled,
    setEnabled,
    pickJaVoice,
    composeVerdictSpeech,
  };
})();
