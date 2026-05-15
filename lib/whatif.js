"use strict";

/*
 * lib/whatif.js — 「もしも、オッズが変わったら」What-If シミュレータ
 *
 * 触って学ぶ EV。スライダーを動かすと期待値がリアルタイムで更新される。
 * 教育的価値: 「期待値とは何か」を文字で説明するより、触らせる方が早い。
 *
 * 結論カードに pick が出ている時のみ表示される。
 */

(function () {
  if (typeof window === "undefined") return;

  let _current = null;  // { number, name, odds, prob, popularity, grade }
  let _onPickReceived = null;

  function $(s, root) { return (root || document).querySelector(s); }

  function evClass(ev) {
    if (!Number.isFinite(ev)) return "wi-ev-zero";
    if (ev >= 1.30) return "wi-ev-s";
    if (ev >= 1.10) return "wi-ev-a";
    if (ev >= 1.00) return "wi-ev-b";
    if (ev >= 0.85) return "wi-ev-c";
    return "wi-ev-d";
  }
  function evGrade(ev) {
    if (!Number.isFinite(ev)) return "?";
    if (ev >= 1.30) return "S";
    if (ev >= 1.10) return "A";
    if (ev >= 1.00) return "B";
    if (ev >= 0.85) return "C";
    return "D";
  }
  function fmtPct(p) { return (p * 100).toFixed(1) + "%"; }
  function fmtDelta(diff) {
    const sign = diff >= 0 ? "+" : "";
    return `${sign}${(diff * 100).toFixed(0)}%`;
  }

  function ensureCard() {
    let card = document.getElementById("card-whatif");
    if (card) return card;
    const anchor = document.getElementById("card-reasoning");
    if (!anchor || !anchor.parentNode) return null;
    card = document.createElement("section");
    card.id = "card-whatif";
    card.className = "whatif-card";
    card.hidden = true;
    card.innerHTML = `
      <div class="whatif-head">
        <h2 class="sc-title">🎚 もしも、条件が変わったら?</h2>
        <button id="wi-reset" type="button" class="wi-reset">↻ 元に戻す</button>
      </div>
      <p class="whatif-hint">スライダーを動かすと、その場で期待値が変わります。<br>「もし 3.2 倍が 5.0 倍だったら…」を体感してください。</p>
      <div class="whatif-target">
        <div class="wi-target-num" id="wi-target-num">--</div>
        <div class="wi-target-name" id="wi-target-name">--</div>
      </div>
      <div class="whatif-sliders">
        <div class="wi-row">
          <label class="wi-label">オッズ</label>
          <input id="wi-odds" type="range" min="10" max="1000" step="1" value="32" class="wi-slider">
          <output id="wi-odds-val" class="wi-out">3.2倍</output>
        </div>
        <div class="wi-row">
          <label class="wi-label">推定勝率</label>
          <input id="wi-prob" type="range" min="1" max="900" step="1" value="450" class="wi-slider">
          <output id="wi-prob-val" class="wi-out">45.0%</output>
        </div>
      </div>
      <div class="whatif-result" id="wi-result">
        <div class="wi-ev-meter">
          <div class="wi-ev-fill" id="wi-ev-fill"></div>
          <div class="wi-ev-line wi-ev-line-100" title="EV 1.0 (損益分岐)"></div>
        </div>
        <div class="wi-stats">
          <div class="wi-stat">
            <div class="wi-stat-label">期待値</div>
            <div class="wi-stat-val" id="wi-ev-val">--</div>
          </div>
          <div class="wi-stat">
            <div class="wi-stat-label">グレード</div>
            <div class="wi-stat-val" id="wi-ev-grade">--</div>
          </div>
          <div class="wi-stat">
            <div class="wi-stat-label">現在比</div>
            <div class="wi-stat-val" id="wi-ev-delta">--</div>
          </div>
        </div>
        <p class="wi-msg" id="wi-msg">--</p>
      </div>
    `;
    anchor.parentNode.insertBefore(card, anchor.nextSibling);
    wireUp(card);
    return card;
  }

  function wireUp(card) {
    const oddsSlider = card.querySelector("#wi-odds");
    const probSlider = card.querySelector("#wi-prob");
    const resetBtn   = card.querySelector("#wi-reset");
    oddsSlider.addEventListener("input", recompute);
    probSlider.addEventListener("input", recompute);
    resetBtn.addEventListener("click", reset);
  }

  function setPick(pick) {
    _current = pick ? { ...pick } : null;
    if (!pick) {
      const card = document.getElementById("card-whatif");
      if (card) card.hidden = true;
      return;
    }
    const card = ensureCard();
    if (!card) return;
    card.hidden = false;

    $("#wi-target-num", card).textContent = String(pick.number ?? "--");
    $("#wi-target-name", card).textContent = pick.name || "(馬名未取得)";

    // odds slider: 1.0〜100.0、× 10 でステップ
    const oddsInit = Math.max(1.0, Math.min(100.0, Number(pick.odds) || 3.2));
    $("#wi-odds", card).value = Math.round(oddsInit * 10);

    // prob slider: 0.001〜0.90、× 1000 でステップ
    const probInit = Math.max(0.001, Math.min(0.9, Number(pick.prob) || 0.30));
    $("#wi-prob", card).value = Math.round(probInit * 1000);

    recompute();
  }

  function reset() {
    if (!_current) return;
    setPick(_current);
  }

  function recompute() {
    const card = document.getElementById("card-whatif");
    if (!card || !_current) return;
    const odds = Number($("#wi-odds", card).value) / 10;
    const prob = Number($("#wi-prob", card).value) / 1000;
    $("#wi-odds-val", card).textContent = odds.toFixed(1) + "倍";
    $("#wi-prob-val", card).textContent = fmtPct(prob);

    const ev = prob * odds;
    const evValEl = $("#wi-ev-val", card);
    const evGrEl  = $("#wi-ev-grade", card);
    const evDeltaEl = $("#wi-ev-delta", card);
    const fillEl = $("#wi-ev-fill", card);
    const msgEl = $("#wi-msg", card);

    evValEl.textContent = Number.isFinite(ev) ? ev.toFixed(2) : "--";
    evValEl.className = "wi-stat-val " + evClass(ev);
    evGrEl.textContent = evGrade(ev);
    evGrEl.className = "wi-stat-val " + evClass(ev);

    // 現在 (元の pick) との比較
    const origEv = (_current.prob != null && _current.odds != null) ? _current.prob * _current.odds : null;
    if (origEv != null && Number.isFinite(origEv)) {
      const diff = ev - origEv;
      evDeltaEl.textContent = fmtDelta(diff);
      evDeltaEl.className = "wi-stat-val " + (diff >= 0 ? "wi-ev-a" : "wi-ev-d");
    } else {
      evDeltaEl.textContent = "--";
    }

    // EV メーター (0〜2.0 の範囲を 0〜100% に)
    const fillPct = Math.max(0, Math.min(100, (ev / 2.0) * 100));
    fillEl.style.width = fillPct + "%";

    // 一言メッセージ
    let msg;
    if (ev >= 1.30) msg = "🟢 強い買い目。長期で大きくプラス。";
    else if (ev >= 1.10) msg = "🟢 買い目。長期でプラス。";
    else if (ev >= 1.00) msg = "🟡 損益分岐より上。小幅プラス。";
    else if (ev >= 0.85) msg = "🟠 損益分岐より下。長期では負け越し。";
    else msg = "🔴 完全にマイナス。買うほど損。";
    msgEl.textContent = msg;
  }

  // 結論カード更新を監視して、buy pick が出たら setPick する
  function watch() {
    const num = document.getElementById("pick-num");
    if (!num) return;
    let lastNum = null;
    const tryUpdate = () => {
      const n = num.textContent?.trim();
      if (n === "--" || !n) {
        setPick(null);
        return;
      }
      if (n === lastNum && _current && document.getElementById("card-whatif")?.hidden === false) return;
      // 現在の conclusion から pick を取得
      if (window._currentConclusion?.picks?.length) {
        const top = window._currentConclusion.picks[0];
        setPick(top);
        lastNum = n;
      }
    };
    const mo = new MutationObserver(tryUpdate);
    mo.observe(num, { childList: true, characterData: true, subtree: true });
    tryUpdate();
  }

  // setPick API を露出 (renderPickCard から直接呼ばれる経路用)
  window.KNWhatIf = {
    setPick,
    reset,
    _recompute: recompute,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watch, { once: true });
  } else {
    watch();
  }
})();
