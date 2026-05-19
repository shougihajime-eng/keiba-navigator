/* =====================================================================
   KEIBA NAVIGATOR — glossary.js  (Wave22.9 全面リライト)
   役割:
     1) 23 語の競馬・期待値用語辞書
     2) data-gloss="EV" の要素にホバー/タップで説明表示
     3) ⓘ アイコンを自動付与
   ===================================================================== */
(function () {
  "use strict";

  const GLOSSARY = {
    "EV": {
      title: "期待値 (EV)",
      body: "「推定勝率 × オッズ」で計算。1.0 を超えれば長期的にプラス収支が期待できる。\n例: 勝率 30% × オッズ 4倍 = 1.20 → ×1.20",
    },
    "期待値": {
      title: "期待値",
      body: "勝った時の払戻し見込み ÷ 投資額。1.0 で投資額と同じ・1.10 で 10% プラスの見込み。",
    },
    "回収率": {
      title: "回収率",
      body: "払戻金合計 ÷ 投資金合計 × 100%。100% で損益ゼロ・110% で 10% プラス。長期で 100% 超えが目標。",
    },
    "Kelly": {
      title: "Kelly 基準",
      body: "破産しない範囲で最大の利益が出る投資割合。当アプリでは Half Kelly (1/2 倍) を採用 — より慎重に。",
    },
    "信頼度": {
      title: "AI 信頼度",
      body: "上位 3 頭の確率が突出しているほど高くなる指標。60%+ なら強気・35%- なら様子見の目安。",
    },
    "1着確率": {
      title: "1着確率",
      body: "AI が推定する「この馬が 1 着になる確率」。オッズに引きずられずに馬の能力・近走・コース適性を見て算出。",
    },
    "推定勝率": {
      title: "推定勝率",
      body: "AI が予測する勝率。市場の人気 (オッズ由来) ではなく、馬と騎手と条件から計算する。",
    },
    "オッズ": {
      title: "オッズ",
      body: "100 円賭けたときの払戻倍率。3.5 倍 = 当たれば 350 円。発走直前まで変動する。",
    },
    "単勝": {
      title: "単勝",
      body: "1 着の馬を 1 頭だけ当てる券種。シンプルだが配当はオッズ通り。",
    },
    "複勝": {
      title: "複勝",
      body: "1〜3 着以内に入る馬を 1 頭当てる券種。3 頭まで的中するので的中率は単勝の約 3 倍。",
    },
    "馬連": {
      title: "馬連",
      body: "1・2 着を順不同で 2 頭当てる券種。本命-対抗の組合せで狙うのが基本。",
    },
    "馬単": {
      title: "馬単",
      body: "1・2 着を 着順通り に当てる券種。馬連より配当が高いが当てるのは難しい。",
    },
    "ワイド": {
      title: "ワイド",
      body: "1〜3 着以内に入る 2 頭を当てる券種。3 通りの組合せがあり的中率高め・配当控えめ。",
    },
    "3連複": {
      title: "3連複",
      body: "1〜3 着の 3 頭を 順不同 で当てる券種。本命-対抗-3 着候補で狙うと当たりやすい。",
    },
    "3連単": {
      title: "3連単",
      body: "1・2・3 着を 着順通り に当てる券種。難しい代わりに配当が非常に高い。",
    },
    "WIN5": {
      title: "WIN5",
      body: "JRA 指定 5 レースの 1 着を全部当てる。1 点 200 円・最高配当 6 億円のキャリーオーバーあり。",
    },
    "G1": {
      title: "G1",
      body: "競馬で最も格の高いレース。日本ダービー・天皇賞・有馬記念など。賞金も高く、世界の名馬が集まる。",
    },
    "G2": {
      title: "G2",
      body: "G1 に次ぐ格のレース。G1 の前哨戦としての位置付けが多い。",
    },
    "G3": {
      title: "G3",
      body: "重賞レースの中で 3 番目の格。準オープン馬の主戦場で配当が荒れやすい。",
    },
    "馬場": {
      title: "馬場状態",
      body: "良 (乾いて速い) / 稍重 / 重 / 不良 (湿って遅い) の 4 段階。雨で馬場が悪くなると逃げ・先行馬有利。",
    },
    "ペース": {
      title: "ペース",
      body: "レース展開の速さ。ハイペースは差し・追込有利、スローペースは逃げ・先行有利。AI が脚質分布から予想。",
    },
    "脚質": {
      title: "脚質",
      body: "馬のレース戦法。逃げ (先頭) / 先行 / 差し / 追込 (後方) の 4 タイプ。コースと脚質の相性が重要。",
    },
    "見送り": {
      title: "見送り",
      body: "期待値がマイナスのレースは買わない判断。「買わない技術」が長期で勝者を作る最大の武器。",
    },
    "Walk-forward": {
      title: "Walk-forward 検証",
      body: "過去データを複数期間に分割し、各期間の予測を独立に検証する手法。1 回だけの過去検証より信頼性が高い。",
    },
    "ティア": {
      title: "ティア (Tier)",
      body: "AI の自信レベル。ULTRA (絶好機) > PRIME > GO (勝負) > COND (条件付き) > BEST (参考) > NONE (見送り)。",
    },
    "本命": {
      title: "本命",
      body: "AI が推定 1 着確率が最も高いと判断した馬。当アプリでは「主軸」とも呼ぶ。",
    },
    "対抗": {
      title: "対抗",
      body: "本命に次ぐ評価の馬。本命と組み合わせて馬連やワイドで狙うことが多い。",
    },
    "穴馬": {
      title: "穴馬",
      body: "人気薄だが AI が高評価する馬。当たれば高配当だが当たりにくい。「過小評価検知」で発見する。",
    },
  };

  const TT_ID = "kb-gloss-tooltip";

  function ensureTooltip() {
    let tt = document.getElementById(TT_ID);
    if (!tt) {
      tt = document.createElement("div");
      tt.id = TT_ID;
      tt.className = "kb-gloss-tooltip";
      tt.setAttribute("role", "tooltip");
      document.body.appendChild(tt);
    }
    return tt;
  }

  function hideTooltip() {
    const tt = document.getElementById(TT_ID);
    if (tt) tt.classList.remove("is-visible");
  }

  function showTooltip(anchor, key) {
    const def = GLOSSARY[key];
    if (!def) return;
    const tt = ensureTooltip();
    tt.innerHTML = `
      <div class="ktt-title">${def.title}</div>
      <div class="ktt-body">${def.body.replace(/\n/g, "<br>")}</div>
    `;
    tt.classList.add("is-visible");
    // 位置計算
    const rect = anchor.getBoundingClientRect();
    const ttRect = tt.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - ttRect.width / 2;
    let top  = rect.bottom + 8;
    const pad = 12;
    if (left < pad) left = pad;
    if (left + ttRect.width > window.innerWidth - pad) {
      left = window.innerWidth - ttRect.width - pad;
    }
    if (top + ttRect.height > window.innerHeight - pad) {
      top = rect.top - ttRect.height - 8;
    }
    tt.style.left = left + "px";
    tt.style.top  = top  + "px";
  }

  function bindAll() {
    const anchors = document.querySelectorAll("[data-gloss]");
    anchors.forEach((a) => {
      if (a.dataset.glossBound === "1") return;
      a.dataset.glossBound = "1";

      // ⓘ アイコンを自動付与 (input/button 以外)
      if (a.tagName !== "INPUT" && a.tagName !== "BUTTON" && !a.querySelector(".kb-gloss-icon")) {
        const icon = document.createElement("span");
        icon.className = "kb-gloss-icon";
        icon.textContent = "ⓘ";
        icon.setAttribute("aria-hidden", "true");
        a.appendChild(icon);
      }
      a.classList.add("kb-gloss-anchor");
      a.setAttribute("tabindex", "0");

      const key = a.dataset.gloss;
      a.addEventListener("mouseenter", () => showTooltip(a, key));
      a.addEventListener("focus",      () => showTooltip(a, key));
      a.addEventListener("mouseleave", hideTooltip);
      a.addEventListener("blur",       hideTooltip);
      a.addEventListener("click", (e) => {
        e.stopPropagation();
        const tt = document.getElementById(TT_ID);
        if (tt && tt.classList.contains("is-visible")) hideTooltip();
        else showTooltip(a, key);
      });
    });
  }

  function watchDom() {
    const obs = new MutationObserver((records) => {
      let needRebind = false;
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.matches?.("[data-gloss]") || n.querySelector?.("[data-gloss]")) {
            needRebind = true;
            break;
          }
        }
        if (needRebind) break;
      }
      if (needRebind) bindAll();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest("[data-gloss]") && !e.target.closest("#" + TT_ID)) hideTooltip();
  });

  function init() {
    bindAll();
    watchDom();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.kbGlossary = { GLOSSARY, showTooltip, hideTooltip, rebind: bindAll };
})();
