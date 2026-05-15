"use strict";

/*
 * lib/glossary.js — 競馬用語のやさしい解説をその場で見せる
 *
 * 使い方:
 *   <span data-gloss="ev">EV</span>
 *   または KNGlossary.attach(el, "ev")
 *
 * クリック/長押し → ポップオーバーで定義が表示される
 */

(function () {
  const TERMS = {
    "ev": {
      title: "EV (期待値)",
      body: "「もし同じレースを 100 回やったら、1 円賭けたら平均で何円戻ってくるか」の数字。<br>1.00 → ±0 / 1.10 → 10%プラス / 0.70 → 30%マイナス。<br>長期で勝ちたければ <b>1.00 を超える馬だけ買う</b> のが基本。",
    },
    "kelly": {
      title: "Kelly 基準",
      body: "破産せずに資金を最大化する、賭け金の最適配分を導く理論。<br>このアプリでは <b>Half Kelly</b>(理論値の半分)を採用し、信頼度が低い時は <b>Quarter Kelly</b>(1/4)に切り替えて安全側に寄せる。",
    },
    "tan": {
      title: "単勝(たんしょう)",
      body: "1着になる馬を当てる。一番シンプル。<br>当たれば配当はオッズ通り。1番人気の単勝は 1.5〜3.0 倍が多い。",
    },
    "fuku": {
      title: "複勝(ふくしょう)",
      body: "3着までに入る馬を当てる(8頭立て以上の場合)。<br>当たりやすいぶん配当は低い。長期で安定運用するなら王道。",
    },
    "wakuren": {
      title: "枠連(わくれん)",
      body: "1〜2着に来る2頭の <b>枠</b> の組み合わせを当てる(順不同)。同じ枠は1点購入。",
    },
    "umaren": {
      title: "馬連(うまれん)",
      body: "1〜2着に来る2頭の <b>馬番</b> の組み合わせを当てる(順不同)。",
    },
    "wide": {
      title: "ワイド",
      body: "3着までの中の2頭の組み合わせを当てる。順番は不問。<br>馬連より当たりやすく、複勝より配当が高い「いいとこ取り」。",
    },
    "umatan": {
      title: "馬単(うまたん)",
      body: "1着と2着を <b>順番通り</b> に当てる。馬連より難しいぶん配当が高い。",
    },
    "fuku3": {
      title: "3連複(さんれんぷく)",
      body: "1〜3着に来る3頭の組み合わせを当てる(順不同)。",
    },
    "tan3": {
      title: "3連単(さんれんたん)",
      body: "1着・2着・3着の馬を <b>順番通り</b> に当てる。最も難しく、配当も最高クラス。",
    },
    "popularity": {
      title: "人気(オッズ順位)",
      body: "オッズの安い順に「○番人気」が決まる。<br>1番人気は「みんなが買ってる馬」。当たりやすいが配当は低い。",
    },
    "grade": {
      title: "グレード (S/A/B/C/D)",
      body: "このアプリ独自の判定強さ。<br><b>S</b>(超信頼) <b>A</b>(信頼) <b>B</b>(普通) <b>C</b>(慎重) <b>D</b>(見送り推奨)<br>確信が高いほど上位になる。",
    },
    "confidence": {
      title: "信頼度",
      body: "AI がどれだけ強くその結論を信じているか。<br><b>高め</b>: 複数の根拠が一致 / <b>中</b>: 部分的に揃う / <b>低</b>: 仮データや情報不足。",
    },
    "calibration": {
      title: "自己校正(キャリブレーション)",
      body: "「AI が当たると言った確率」と「実際に当たった確率」のズレを補正する仕組み。<br>例: AI が 40% と言っても実績が 28% なら、次から 28/40 = 0.7 倍してから判断する。",
    },
    "rolling": {
      title: "ローリング的中率",
      body: "直近 N 件(このアプリは 20件)の的中率を 1 件ずつずらしながら表示。<br>AI が育っていれば <b>右肩上がり</b> になる。",
    },
    "air": {
      title: "エア馬券",
      body: "仮想で買ったことにして記録する。実際にお金は動かさない。<br>AI の判断を「もし買っていたら」で検証するための練習モード。",
    },
    "real": {
      title: "リアル馬券",
      body: "実際に購入した馬券の記録。<br>エアより成績が悪い → 買い時を逃している、エアが悪い → ロジックが弱い、というサイン。",
    },
    "backtest": {
      title: "バックテスト",
      body: "過去の記録に対して「もし今の AI のロジックで判断していたら」を計算し直す。<br>補正前 vs 補正後 の累積収支を比較し、自己学習が役立っているかを見る。",
    },
    "edge": {
      title: "エッジ",
      body: "オッズが示す市場の見立てより、AI の推定勝率が高い分のこと。<br>EV − 1 = エッジ。1.20 なら 20% のエッジ。",
    },
    "stake": {
      title: "推奨金額(ステーク)",
      body: "1 レースに賭ける推奨額。<br>1 日予算と 1 レース上限で天井を切り、信頼度に応じて Half/Quarter Kelly でサイジング。<br>EV マイナスなら ¥0(買うな)。",
    },
    "minev": {
      title: "最小 EV 閾値",
      body: "「EV がこの値を超える馬だけ買う」というハードル。<br>1.10 推奨。低すぎると見送れず、高すぎると買い目が出ない。",
    },
  };

  let _pop = null;
  let _anchor = null;
  let _outsideHandler = null;

  function ensurePop() {
    if (_pop && document.body.contains(_pop)) return _pop;
    const el = document.createElement("div");
    el.className = "kn-gloss-pop";
    el.setAttribute("role", "tooltip");
    el.innerHTML = `
      <div class="kn-gloss-title"></div>
      <div class="kn-gloss-body"></div>
      <button class="kn-gloss-close" type="button" aria-label="閉じる">×</button>
    `;
    el.style.position = "fixed";
    el.style.zIndex = "9999";
    document.body.appendChild(el);
    el.querySelector(".kn-gloss-close").addEventListener("click", hide);
    _pop = el;
    return el;
  }

  function show(term, anchorEl) {
    const def = TERMS[term];
    if (!def) return;
    const pop = ensurePop();
    pop.querySelector(".kn-gloss-title").innerHTML = def.title;
    pop.querySelector(".kn-gloss-body").innerHTML  = def.body;
    pop.style.display = "block";
    // 位置: anchor の下 (はみ出すなら上)
    if (anchorEl) {
      _anchor = anchorEl;
      requestAnimationFrame(() => positionPop());
    }
    // クリック外で閉じる
    setTimeout(() => {
      _outsideHandler = (ev) => {
        if (!pop.contains(ev.target) && ev.target !== anchorEl) hide();
      };
      document.addEventListener("click", _outsideHandler, { capture: true });
      document.addEventListener("touchstart", _outsideHandler, { capture: true, passive: true });
    }, 50);
  }

  function positionPop() {
    if (!_pop || !_anchor) return;
    const a = _anchor.getBoundingClientRect();
    const pw = _pop.offsetWidth  || 280;
    const ph = _pop.offsetHeight || 120;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = a.left + a.width / 2 - pw / 2;
    left = Math.max(8, Math.min(vw - pw - 8, left));
    let top = a.bottom + 10;
    if (top + ph > vh - 8) top = Math.max(8, a.top - ph - 10);
    _pop.style.left = left + "px";
    _pop.style.top  = top + "px";
  }

  function hide() {
    if (_pop) _pop.style.display = "none";
    if (_outsideHandler) {
      document.removeEventListener("click", _outsideHandler, { capture: true });
      document.removeEventListener("touchstart", _outsideHandler, { capture: true });
      _outsideHandler = null;
    }
    _anchor = null;
  }

  function attach(el, term) {
    if (!el || !TERMS[term]) return;
    el.classList.add("kn-gloss-target");
    el.setAttribute("tabindex", "0");
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", `${TERMS[term].title} の説明`);
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      show(term, el);
    });
  }

  function scan(root = document) {
    const nodes = root.querySelectorAll("[data-gloss]");
    nodes.forEach(n => {
      if (n._knGlossBound) return;
      n._knGlossBound = true;
      const term = n.getAttribute("data-gloss");
      attach(n, term);
    });
  }

  // 自動 attach: 初回 + 5 秒ごとに新しい要素を拾う(SPA 的に DOM が変わるので)
  function init() {
    scan(document);
    setInterval(() => scan(document), 5000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  // ESC で閉じる
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });
  window.addEventListener("resize", positionPop, { passive: true });
  window.addEventListener("scroll", () => { if (_pop?.style.display === "block") positionPop(); }, { passive: true });

  window.KNGlossary = {
    terms: TERMS,
    show, hide, attach, scan,
  };
})();
