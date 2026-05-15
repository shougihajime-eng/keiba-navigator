"use strict";

/*
 * lib/demo_races.js — JV-Link 接続前でも本物っぽく遊べるデモレース ライブラリ
 *
 * 過去の G1 レースをモデルに、もし AI が予想していたらどう判定したかを
 * 触って確かめられる。実データ取得前の「体験版」として強力。
 *
 * 注意:
 *  - これは教育・体験用の「仮想再現」であり、実際のレース結果ではありません
 *  - 馬名はカナで実在の名前を借りていますが、AI の判定は架空のロジックです
 *  - 「これで賭けて勝てる」とは限らない (リアル馬券はあくまで自己責任)
 */

const DEMO_RACES = [
    {
      id: "demo_2023_takarazuka",
      name: "宝塚記念 (2023 デモ)",
      course: "阪神 2200m 芝",
      going: "良",
      grade: "G1",
      description: "夏の上半期グランプリ。1番人気が荒れることが多い。",
      horses: [
        { number: 1, name: "イクイノックス",   odds: 1.7,  popularity: 1, prev: 1 },
        { number: 2, name: "ジャスティンパレス", odds: 5.5,  popularity: 2, prev: 2 },
        { number: 3, name: "ボッケリーニ",     odds: 9.1,  popularity: 3, prev: 4 },
        { number: 4, name: "スルーセブンシーズ", odds: 51.0, popularity: 9, prev: 7 },
        { number: 5, name: "アスクビクターモア", odds: 28.0, popularity: 6, prev: 5 },
        { number: 6, name: "ディープボンド",   odds: 12.0, popularity: 4, prev: 6 },
        { number: 7, name: "ライラック",       odds: 75.0, popularity: 12, prev: 9 },
        { number: 8, name: "ユニコーンライオン", odds: 38.0, popularity: 8, prev: 8 },
      ],
    },
    {
      id: "demo_2024_satsukisho",
      name: "皐月賞 (2024 デモ)",
      course: "中山 2000m 芝",
      going: "稍重",
      grade: "G1",
      description: "三冠の初戦。3歳牡馬。先行有利のトリッキーなコース。",
      horses: [
        { number: 1, name: "ジャスティンミラノ", odds: 4.2,  popularity: 1, prev: 1 },
        { number: 2, name: "コスモキュランダ",  odds: 6.8,  popularity: 2, prev: 1 },
        { number: 3, name: "メイショウタバル",  odds: 9.5,  popularity: 3, prev: 2 },
        { number: 4, name: "シンエンペラー",    odds: 11.0, popularity: 4, prev: 3 },
        { number: 5, name: "レガレイラ",        odds: 13.0, popularity: 5, prev: 4 },
        { number: 6, name: "ダノンエアズロック", odds: 27.0, popularity: 7, prev: 5 },
        { number: 7, name: "ジャンタルマンタル", odds: 16.0, popularity: 6, prev: 2 },
        { number: 8, name: "ゴンバデカーブース", odds: 65.0, popularity: 11, prev: 7 },
      ],
    },
    {
      id: "demo_2023_japan_cup",
      name: "ジャパンカップ (2023 デモ)",
      course: "東京 2400m 芝",
      going: "良",
      grade: "G1",
      description: "国際招待。3歳〜古馬の頂点を争う。配当は手堅い。",
      horses: [
        { number: 1, name: "イクイノックス",     odds: 1.4,  popularity: 1, prev: 1 },
        { number: 2, name: "リバティアイランド", odds: 3.6,  popularity: 2, prev: 1 },
        { number: 3, name: "ドウデュース",       odds: 7.2,  popularity: 3, prev: 2 },
        { number: 4, name: "スターズオンアース", odds: 9.5,  popularity: 4, prev: 3 },
        { number: 5, name: "タイトルホルダー",   odds: 18.0, popularity: 5, prev: 5 },
        { number: 6, name: "ハーパー",           odds: 38.0, popularity: 7, prev: 4 },
        { number: 7, name: "ヴェラアズール",     odds: 42.0, popularity: 8, prev: 6 },
        { number: 8, name: "イレリアン",         odds: 88.0, popularity: 12, prev: 9 },
      ],
    },
    {
      id: "demo_2024_arima",
      name: "有馬記念 (2024 デモ)",
      course: "中山 2500m 芝",
      going: "良",
      grade: "G1",
      description: "ファン投票で選ばれるグランプリ。年末の総決算。波乱多め。",
      horses: [
        { number: 1, name: "レガレイラ",        odds: 8.5,  popularity: 4, prev: 6 },
        { number: 2, name: "ドウデュース",      odds: 1.9,  popularity: 1, prev: 1 },
        { number: 3, name: "ダノンデサイル",    odds: 7.0,  popularity: 3, prev: 1 },
        { number: 4, name: "ローシャムパーク",  odds: 13.0, popularity: 5, prev: 3 },
        { number: 5, name: "シャフリヤール",    odds: 6.2,  popularity: 2, prev: 2 },
        { number: 6, name: "ジャスティンパレス", odds: 22.0, popularity: 7, prev: 5 },
        { number: 7, name: "スターズオンアース", odds: 17.0, popularity: 6, prev: 4 },
        { number: 8, name: "ハヤヤッコ",        odds: 95.0, popularity: 13, prev: 11 },
      ],
    },
    {
      id: "demo_dirt_handicap",
      name: "ハンデキャップ ダート (デモ)",
      course: "東京 1600m ダート",
      going: "良",
      grade: "ハンデ",
      description: "ダートのハンデ戦。実力差が斤量で平衡される波乱含み。",
      horses: [
        { number: 1, name: "サンライズホーク",   odds: 3.8,  popularity: 1, prev: 2 },
        { number: 2, name: "ロードカナロア二世", odds: 5.2,  popularity: 2, prev: 1 },
        { number: 3, name: "ハヤブサナンデクン", odds: 9.5,  popularity: 4, prev: 5 },
        { number: 4, name: "ハジメフライト",     odds: 7.8,  popularity: 3, prev: 3 },
        { number: 5, name: "シャドウリーフ",     odds: 18.0, popularity: 5, prev: 7 },
        { number: 6, name: "ナイトオーシャン",   odds: 35.0, popularity: 8, prev: 8 },
        { number: 7, name: "ブラックインパクト", odds: 22.0, popularity: 6, prev: 6 },
        { number: 8, name: "オウシュウフルム",   odds: 48.0, popularity: 10, prev: 9 },
      ],
    },
];

function toTextarea(race) {
  return race.horses.map(h => `${h.number} ${h.name} ${h.odds.toFixed(1)} ${h.popularity} ${h.prev}`).join("\n");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { DEMO_RACES, toTextarea };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  (function () {

  // ─── デモレース ピッカー モーダル ───────────────────
  function ensureUI() {
    if (document.getElementById("kn-demo-overlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "kn-demo-overlay";
    overlay.className = "kn-demo-overlay";
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="kn-demo-card">
        <button class="kn-demo-close" type="button" aria-label="閉じる">×</button>
        <div class="kn-demo-title">🎟 デモレースで遊ぶ</div>
        <div class="kn-demo-hint">JV-Link 契約・接続が完了する前でも、本物っぽい G1 レースで AI 判定を体験できます。<br>これは <b>過去レースをモデルにした体験用</b> で、実際の結果や予想ではありません。</div>
        <div class="kn-demo-list" id="kn-demo-list"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector(".kn-demo-close").addEventListener("click", close);

    const list = overlay.querySelector("#kn-demo-list");
    list.innerHTML = DEMO_RACES.map(r => `
      <button type="button" class="kn-demo-item" data-id="${r.id}">
        <div class="kn-demo-item-grade">${r.grade}</div>
        <div class="kn-demo-item-main">
          <div class="kn-demo-item-name">${r.name}</div>
          <div class="kn-demo-item-meta">${r.course} · ${r.going}</div>
          <div class="kn-demo-item-desc">${r.description}</div>
        </div>
        <div class="kn-demo-item-go">▸</div>
      </button>
    `).join("");

    list.querySelectorAll(".kn-demo-item").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const r = DEMO_RACES.find(x => x.id === id);
        if (!r) return;
        run(r);
      });
    });
  }

  function open() {
    ensureUI();
    document.getElementById("kn-demo-overlay").hidden = false;
  }
  function close() {
    const o = document.getElementById("kn-demo-overlay");
    if (o) o.hidden = true;
  }

  function run(race) {
    const ta = document.getElementById("mi-textarea");
    const nameEl = document.getElementById("mi-race-name");
    if (!ta) return;
    ta.value = toTextarea(race);
    if (nameEl) nameEl.value = race.name;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    close();
    // 自動で判定実行
    document.getElementById("mi-submit")?.click();
    if (window.showToast) window.showToast(`🎟 ${race.name} で判定中…`, "ok");
    // 結論カードまでスクロール
    setTimeout(() => {
      document.getElementById("big-verdict")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 200);
  }

  window.KNDemoRaces = {
    list: DEMO_RACES,
    open, close, run,
    toTextarea,
  };
})();
}
