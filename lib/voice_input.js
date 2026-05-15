"use strict";

/*
 * lib/voice_input.js — 音声で馬を入力する魔法 (Web Speech API)
 *
 * パース関数は Node からも require() できるよう純粋関数として最上位にエクスポート。
 * 実際の音声認識セッション・DOM 操作は IIFE 内で window 検出後にのみ実行。
 */

// ── 日本語数値の正規化 ─────────────────────────────────
// 「いち」「に」「さん」… → 1 2 3
// 「3.2」「3てん2」「3点2」 → 3.2
// 「十」「十五」「二十三」 → 10 / 15 / 23

const KANA_DIGIT = {
  "ゼロ": 0, "れい": 0, "まる": 0,
  "いち": 1, "ひと": 1,
  "に": 2, "ふた": 2,
  "さん": 3, "み": 3,
  "よん": 4, "し": 4,
  "ご": 5, "いつ": 5,
  "ろく": 6, "む": 6,
  "なな": 7, "しち": 7,
  "はち": 8, "や": 8,
  "きゅう": 9, "く": 9, "ここの": 9,
  "じゅう": 10, "とお": 10,
};

const KANJI_DIGIT = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };

function kanaPartToNum(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (/^\d+$/.test(t)) return Number(t);

  // 漢数字 (一〜九十) — 単純合成
  if (/^[一二三四五六七八九十]+$/.test(t)) {
    if (t === "十") return 10;
    if (t.startsWith("十")) return 10 + (KANJI_DIGIT[t[1]] || 0);
    if (t.endsWith("十"))   return (KANJI_DIGIT[t[0]] || 0) * 10;
    const tenIdx = t.indexOf("十");
    if (tenIdx > 0) return (KANJI_DIGIT[t[0]] || 0) * 10 + (KANJI_DIGIT[t[tenIdx + 1]] || 0);
    let n = 0;
    for (const ch of t) n = n * 10 + (KANJI_DIGIT[ch] || 0);
    return n;
  }

  if (Object.prototype.hasOwnProperty.call(KANA_DIGIT, t)) return KANA_DIGIT[t];
  return null;
}

function kanaToNumber(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);

  // 「3.2」「3てん2」「3点2」
  const dotMatch = t.match(/^(\d+|[一二三四五六七八九十]+|[ぁ-んァ-ン]+)\s*(?:てん|点|\.)\s*(\d+|[一二三四五六七八九十]+|[ぁ-んァ-ン]+)$/);
  if (dotMatch) {
    const a = kanaPartToNum(dotMatch[1]);
    const b = kanaPartToNum(dotMatch[2]);
    if (a != null && b != null) return Number(`${a}.${b}`);
  }
  return kanaPartToNum(t);
}

/**
 * 認識テキストを { umaban, name, odds, popularity, prevPos, raw } に分解
 *
 * 仕様:
 * - 馬番: 「○番」(ただし「○番人気」「○着」は除外)
 * - 人気: 「○番人気」or 「○人気」
 * - 前走: 「前走○着」「前回○着」「前○着」「○着」
 * - オッズ: 「○○倍」「○てん○倍」 or 入力中の小数(3.2)
 * - 馬名: 上記を除いた最長のカナ・漢字塊 (2文字以上)
 *
 * 部分情報でも返す。buildLine() で「分かるものだけ」並べる
 */
function parseSpoken(text) {
  if (!text) return null;
  const t = String(text).replace(/[、,]/g, " ").trim();

  let umaban = null, odds = null, popularity = null, prevPos = null;
  let name = null;

  // 馬番候補: 「○番」のうち「○番人気」「○着」「○番目」「○番手」を除外
  const numBanMatches = [...t.matchAll(/(\d+|[一二三四五六七八九十]+|いち|に|さん|よん|ご|ろく|なな|はち|きゅう|じゅう)\s*番(?!人気|目|手)/g)];

  // 人気
  const popMatch = t.match(/(\d+|[一二三四五六七八九十]+|いち|に|さん|よん|ご|ろく|なな|はち|きゅう|じゅう)\s*(?:番)?\s*人気/);
  if (popMatch) popularity = kanaToNumber(popMatch[1]);

  // 前走着順
  const prevMatch = t.match(/(?:前走|前回|前)\s*(\d+|[一二三四五六七八九十]+|いち|に|さん|よん|ご|ろく|なな|はち|きゅう|じゅう)\s*着/);
  if (prevMatch) prevPos = kanaToNumber(prevMatch[1]);
  else {
    const finishMatch = t.match(/(\d+|[一二三四五六七八九十]+|いち|に|さん|よん|ご|ろく|なな|はち|きゅう|じゅう)\s*着/);
    if (finishMatch) prevPos = kanaToNumber(finishMatch[1]);
  }

  // オッズ: 「○倍」or 「○てん○倍」or 単独の小数
  const oddsMatch = t.match(/(\d+(?:\.\d+)?|\d+\s*(?:てん|点)\s*\d+)\s*倍/);
  if (oddsMatch) {
    odds = kanaToNumber(oddsMatch[1].replace(/\s+/g, ""));
  } else {
    const dec = t.match(/(\d+\.\d+)/);
    if (dec) odds = Number(dec[1]);
  }

  // 馬番
  if (numBanMatches.length > 0) {
    umaban = kanaToNumber(numBanMatches[0][1]);
  }

  // 馬名: 数字・記号を除いた中で最長のカナ/漢字塊
  let stripped = t;
  if (popMatch) stripped = stripped.replace(popMatch[0], " ");
  if (prevMatch) stripped = stripped.replace(prevMatch[0], " ");
  if (oddsMatch) stripped = stripped.replace(oddsMatch[0], " ");
  for (const m of numBanMatches) stripped = stripped.replace(m[0], " ");
  stripped = stripped.replace(/(\d+(?:\.\d+)?)/g, " ").replace(/\s+/g, " ").trim();

  const nameMatch = stripped.match(/[ぁ-んァ-ヶ一-龠ー]{2,}/g);
  if (nameMatch && nameMatch.length) {
    name = nameMatch.sort((a, b) => b.length - a.length)[0];
  }

  return { umaban, name, odds, popularity, prevPos, raw: text };
}

// textarea 1 行 = "馬番 馬名 オッズ 人気 前走"
function buildLine(parsed) {
  if (!parsed) return null;
  const parts = [];
  if (parsed.umaban != null) parts.push(String(parsed.umaban));
  if (parsed.name) parts.push(parsed.name);
  if (parsed.odds != null) parts.push(parsed.odds.toFixed(1));
  if (parsed.popularity != null) parts.push(String(parsed.popularity));
  if (parsed.prevPos != null) parts.push(String(parsed.prevPos));
  if (parts.length < 2) return null;
  return parts.join(" ");
}

// ─── Node export (test 用) ─────────────────────────────
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseSpoken, buildLine, kanaToNumber, kanaPartToNum };
}

// ─── Browser side: IIFE で UI orchestration ───────────────
if (typeof window !== "undefined" && typeof document !== "undefined") {
  (function () {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const SUPPORTED = !!SR;

    let _recognition = null;
    let _state = "idle";
    let _pendingLine = null;

    function ensureUI() {
      if (document.getElementById("kn-vi-overlay")) return;
      const overlay = document.createElement("div");
      overlay.id = "kn-vi-overlay";
      overlay.className = "kn-vi-overlay";
      overlay.hidden = true;
      overlay.innerHTML = `
        <div class="kn-vi-card">
          <div class="kn-vi-mic">
            <span class="kn-vi-ring"></span>
            <span class="kn-vi-ring kn-vi-ring-2"></span>
            <span class="kn-vi-mic-icon">🎙</span>
          </div>
          <div class="kn-vi-title">聞いています…</div>
          <div class="kn-vi-hint">「ディープ 3.2倍 1番人気 前走1着」のように話してください</div>
          <div class="kn-vi-transcript" hidden></div>
          <div class="kn-vi-parsed" hidden></div>
          <div class="kn-vi-actions" hidden>
            <button class="kn-vi-redo" type="button">🔁 もう一度</button>
            <button class="kn-vi-ok"   type="button">✓ 追加</button>
          </div>
          <button class="kn-vi-close" type="button" aria-label="閉じる">×</button>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.querySelector(".kn-vi-close").addEventListener("click", abort);
      overlay.querySelector(".kn-vi-redo").addEventListener("click", () => {
        _pendingLine = null;
        hideConfirm();
        startListen();
      });
      overlay.querySelector(".kn-vi-ok").addEventListener("click", () => {
        commitLine();
      });
    }

    function show()  { const el = document.getElementById("kn-vi-overlay"); if (el) el.hidden = false; }
    function hide()  { const el = document.getElementById("kn-vi-overlay"); if (el) el.hidden = true; }
    function setTitle(t) { const el = document.querySelector("#kn-vi-overlay .kn-vi-title"); if (el) el.textContent = t; }
    function setHint(t)  { const el = document.querySelector("#kn-vi-overlay .kn-vi-hint");  if (el) el.textContent = t; }

    function showConfirm(parsed, line) {
      const tr = document.querySelector("#kn-vi-overlay .kn-vi-transcript");
      const p  = document.querySelector("#kn-vi-overlay .kn-vi-parsed");
      const a  = document.querySelector("#kn-vi-overlay .kn-vi-actions");
      if (tr) { tr.hidden = false; tr.textContent = "「" + (parsed?.raw || "") + "」と聞こえました"; }
      if (p)  { p.hidden = false; p.textContent = line; }
      if (a)  { a.hidden = false; }
      setTitle("これで追加しますか?");
      setHint("間違っていれば「もう一度」で言い直せます");
      document.querySelector("#kn-vi-overlay .kn-vi-mic")?.classList.remove("listening");
    }
    function hideConfirm() {
      const tr = document.querySelector("#kn-vi-overlay .kn-vi-transcript");
      const p  = document.querySelector("#kn-vi-overlay .kn-vi-parsed");
      const a  = document.querySelector("#kn-vi-overlay .kn-vi-actions");
      if (tr) tr.hidden = true;
      if (p)  p.hidden = true;
      if (a)  a.hidden = true;
    }

    function startListen() {
      if (!SUPPORTED) {
        if (window.showToast) window.showToast("お使いのブラウザは音声入力に対応していません(Chrome/Edge/Safari で動きます)", "warn");
        return;
      }
      ensureUI();
      show();
      setTitle("聞いています…");
      setHint("「ディープ 3.2倍 1番人気 前走1着」のように話してください");
      hideConfirm();
      document.querySelector("#kn-vi-overlay .kn-vi-mic")?.classList.add("listening");

      try {
        _recognition = new SR();
        _recognition.lang = "ja-JP";
        _recognition.interimResults = false;
        _recognition.maxAlternatives = 1;
        _recognition.continuous = false;

        _recognition.onresult = (ev) => {
          const txt = ev.results[0]?.[0]?.transcript || "";
          const parsed = parseSpoken(txt);
          const line = buildLine(parsed);
          if (!line) {
            setTitle("うまく聞き取れませんでした");
            setHint("「ディープ 3.2倍 1番人気」のように言ってみてください");
            document.querySelector("#kn-vi-overlay .kn-vi-mic")?.classList.remove("listening");
            const a = document.querySelector("#kn-vi-overlay .kn-vi-actions");
            if (a) a.hidden = false;
            const tr = document.querySelector("#kn-vi-overlay .kn-vi-transcript");
            if (tr) { tr.hidden = false; tr.textContent = "「" + txt + "」と聞こえました(数字が読み取れず)"; }
            return;
          }
          _pendingLine = line;
          showConfirm(parsed, line);
        };
        _recognition.onerror = (ev) => {
          setTitle("音声認識エラー");
          setHint(ev?.error === "not-allowed" ? "マイクへのアクセスを許可してください" : "もう一度お試しください");
          document.querySelector("#kn-vi-overlay .kn-vi-mic")?.classList.remove("listening");
          const a = document.querySelector("#kn-vi-overlay .kn-vi-actions");
          if (a) a.hidden = false;
        };
        _recognition.onend = () => {
          if (_state === "listening") _state = "idle";
        };

        _state = "listening";
        _recognition.start();
      } catch (e) {
        setTitle("音声認識を開始できません");
        setHint(String(e?.message || e));
      }
    }

    function commitLine() {
      if (!_pendingLine) return;
      const ta = document.getElementById("mi-textarea");
      if (ta) {
        const cur = ta.value.trimEnd();
        ta.value = (cur ? cur + "\n" : "") + _pendingLine + "\n";
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (window.showToast) window.showToast("🎙 1頭追加しました", "ok");
      _pendingLine = null;
      abort();
    }

    function abort() {
      try { _recognition?.abort(); } catch {}
      _recognition = null;
      _state = "idle";
      hide();
      document.querySelector("#kn-vi-overlay .kn-vi-mic")?.classList.remove("listening");
    }

    window.KNVoiceInput = {
      supported: SUPPORTED,
      start: startListen,
      abort,
      parseSpoken,
      buildLine,
      _kanaToNumber: kanaToNumber,
    };
  })();
}
