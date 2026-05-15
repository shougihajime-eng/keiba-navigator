"use strict";

/*
 * lib/ocr.js — 📷 新聞・スクショから馬を読み取る (Tesseract.js を lazy load)
 *
 * 設計:
 * - Tesseract.js は ~10MB あるので、ユーザがボタンを押した時点で初めて CDN から読み込む
 * - 日本語 (jpn) と英字 (eng) を両方ロード
 * - 進捗 0〜100% を UI に表示
 * - 認識結果を行ごとに切り出し → 馬番/オッズ/人気を抽出 → 確認画面で見せる
 *
 * 重要: 新聞のオッズ表は誤認識しやすい。あくまでベストエフォート。
 */

/**
 * OCR テキストから 1 行 = 1 頭 の形に整形 (純関数・Node からテスト可能)
 *
 * 戦略:
 *  - 1 行ずつ走査
 *  - 馬番候補(1〜30 の整数)を見つける
 *  - オッズ (X.X 形式の小数 or 整数で見えるもの) を探す
 *  - 人気 (○番人気 or ○人気) を探す
 *  - 馬名候補(カナ/漢字 2 文字以上の塊)
 *  - 2 つ以上の手がかりがあれば 1 行として採用
 */
function parseToLines(raw) {
  if (!raw) return [];
  const rows = String(raw).split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const row of rows) {
    const nums = [...row.matchAll(/\d+(?:\.\d+)?/g)].map(m => Number(m[0]));
    const ints = nums.filter(n => Number.isInteger(n) && n > 0 && n <= 30);
    const decs = nums.filter(n => !Number.isInteger(n) && n > 0 && n < 1000);
    const nameMatch = row.match(/[ぁ-んァ-ヶ一-龠ー]{2,}/);
    const umaban = ints.length ? ints.sort((a, b) => a - b)[0] : null;
    const odds = decs.length ? decs[0] : null;
    const popMatch = row.match(/(\d+)\s*番人気/) || row.match(/(\d+)\s*人気/);
    const popularity = popMatch ? Number(popMatch[1]) : null;

    const parts = [];
    if (umaban != null) parts.push(String(umaban));
    if (nameMatch) parts.push(nameMatch[0]);
    if (odds != null) parts.push(odds.toFixed(1));
    if (popularity != null) parts.push(String(popularity));
    if (parts.length >= 2) out.push(parts.join(" "));
  }
  return out;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseToLines };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  (function () {
    const TESSERACT_CDN = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    let _tesseractLoading = null;
    let _tesseractReady = false;

    function loadTesseract() {
      if (_tesseractReady) return Promise.resolve();
      if (_tesseractLoading) return _tesseractLoading;
      _tesseractLoading = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = TESSERACT_CDN;
        script.crossOrigin = "anonymous";
        script.onload = () => { _tesseractReady = true; resolve(); };
        script.onerror = () => reject(new Error("Tesseract.js の読み込みに失敗 (オフライン or CDN到達不可)"));
        document.head.appendChild(script);
      });
      return _tesseractLoading;
    }

    function ensureUI() {
      if (document.getElementById("kn-ocr-overlay")) return;
      const overlay = document.createElement("div");
      overlay.id = "kn-ocr-overlay";
      overlay.className = "kn-ocr-overlay";
      overlay.hidden = true;
      overlay.innerHTML = `
        <div class="kn-ocr-card">
          <button class="kn-ocr-close" type="button" aria-label="閉じる">×</button>
          <div class="kn-ocr-title">📷 写真から読み取り</div>
          <div class="kn-ocr-hint">新聞のオッズ表 / スマホのスクリーンショット どちらでも可。<br>解像度が高くて文字がはっきりした画像ほど精度が上がります。</div>
          <label class="kn-ocr-pick">
            📁 画像を選ぶ
            <input type="file" id="kn-ocr-file" accept="image/*" capture="environment" hidden>
          </label>
          <div id="kn-ocr-preview" class="kn-ocr-preview" hidden>
            <img id="kn-ocr-img" class="kn-ocr-img" alt="">
          </div>
          <div id="kn-ocr-progress" class="kn-ocr-progress" hidden>
            <div class="kn-ocr-progress-track"><div id="kn-ocr-progress-fill" class="kn-ocr-progress-fill"></div></div>
            <div id="kn-ocr-progress-text" class="kn-ocr-progress-text">準備中…</div>
          </div>
          <div id="kn-ocr-result" class="kn-ocr-result" hidden>
            <div class="kn-ocr-result-title">読み取り結果</div>
            <pre id="kn-ocr-result-raw" class="kn-ocr-result-raw"></pre>
            <div class="kn-ocr-result-title">推定される馬リスト</div>
            <pre id="kn-ocr-result-lines" class="kn-ocr-result-lines"></pre>
            <p class="kn-ocr-warn">⚠ 自動認識は誤りを含むことがあります。textarea に追記したあと、必ず確認してください。</p>
            <div class="kn-ocr-actions">
              <button class="kn-ocr-cancel" type="button">キャンセル</button>
              <button class="kn-ocr-ok" type="button">✓ textarea に追記</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.querySelector(".kn-ocr-close").addEventListener("click", close);
      overlay.querySelector(".kn-ocr-cancel").addEventListener("click", close);
      overlay.querySelector("#kn-ocr-file").addEventListener("change", onFile);
      overlay.querySelector(".kn-ocr-ok").addEventListener("click", commit);
    }

    function open() {
      ensureUI();
      const o = document.getElementById("kn-ocr-overlay");
      if (!o) return;
      o.hidden = false;
      document.getElementById("kn-ocr-file").value = "";
      document.getElementById("kn-ocr-preview").hidden = true;
      document.getElementById("kn-ocr-progress").hidden = true;
      document.getElementById("kn-ocr-result").hidden = true;
    }
    function close() {
      const o = document.getElementById("kn-ocr-overlay");
      if (o) o.hidden = true;
    }

    let _parsedLines = [];

    async function onFile(ev) {
      const file = ev.target.files?.[0];
      if (!file) return;
      if (!/^image\//.test(file.type)) {
        if (window.showToast) window.showToast("画像ファイルを選んでください", "warn");
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        const img = document.getElementById("kn-ocr-img");
        img.src = reader.result;
        document.getElementById("kn-ocr-preview").hidden = false;
        await runOcr(reader.result);
      };
      reader.readAsDataURL(file);
    }

    async function runOcr(dataUrl) {
      const progBox = document.getElementById("kn-ocr-progress");
      const progFill = document.getElementById("kn-ocr-progress-fill");
      const progText = document.getElementById("kn-ocr-progress-text");
      const resultBox = document.getElementById("kn-ocr-result");
      progBox.hidden = false; resultBox.hidden = true;
      progText.textContent = "Tesseract.js を読み込み中…(初回は ~10MB のダウンロード)";
      progFill.style.width = "5%";
      progFill.style.background = "";

      try {
        await loadTesseract();
      } catch (e) {
        progText.textContent = "読み込み失敗: " + (e?.message || e);
        progFill.style.width = "100%";
        progFill.style.background = "var(--acc-danger)";
        return;
      }

      if (!window.Tesseract) {
        progText.textContent = "Tesseract.js が利用できません";
        return;
      }

      progText.textContent = "画像を読み取り中…";
      try {
        const result = await window.Tesseract.recognize(dataUrl, "jpn+eng", {
          logger: (m) => {
            if (m.status === "loading tesseract core" || m.status === "initializing tesseract") {
              progText.textContent = "コア初期化…";
              progFill.style.width = "20%";
            } else if (m.status === "loading language traineddata") {
              progText.textContent = "日本語データ ロード中…";
              progFill.style.width = "40%";
            } else if (m.status === "initializing api") {
              progText.textContent = "API 初期化…";
              progFill.style.width = "55%";
            } else if (m.status === "recognizing text") {
              const p = Math.min(100, Math.round(55 + m.progress * 45));
              progText.textContent = `読み取り中 ${Math.round(m.progress * 100)}%`;
              progFill.style.width = p + "%";
            }
          },
        });
        const raw = (result?.data?.text || "").trim();
        const lines = parseToLines(raw);
        showResult(raw, lines);
      } catch (e) {
        progText.textContent = "認識エラー: " + (e?.message || e);
        progFill.style.background = "var(--acc-danger)";
      }
    }

    function showResult(raw, lines) {
      _parsedLines = lines;
      document.getElementById("kn-ocr-progress").hidden = true;
      document.getElementById("kn-ocr-result").hidden = false;
      document.getElementById("kn-ocr-result-raw").textContent = raw || "(認識テキストなし)";
      document.getElementById("kn-ocr-result-lines").textContent = lines.length ? lines.join("\n") : "(馬リストとして抽出できませんでした)";
    }

    function commit() {
      if (!_parsedLines.length) {
        if (window.showToast) window.showToast("追記できる行がありません", "warn");
        return;
      }
      const ta = document.getElementById("mi-textarea");
      if (!ta) return;
      const cur = ta.value.trimEnd();
      ta.value = (cur ? cur + "\n" : "") + _parsedLines.join("\n") + "\n";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      if (window.showToast) window.showToast(`📷 ${_parsedLines.length} 行を追記しました`, "ok");
      try { window.KNAchievements?.unlock("voice_used"); } catch {}
      close();
    }

    window.KNOcr = {
      open,
      close,
      parseToLines,
      _runOcr: runOcr,
    };
  })();
}
