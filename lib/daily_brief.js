"use strict";

/*
 * lib/daily_brief.js — ホーム画面トップの「今日の概要」カード
 *
 * 表示内容:
 *   - 時間帯に応じたあいさつ (おはよう/こんにちは/お疲れ様)
 *   - 今日の日付 + 曜日
 *   - 週末/平日 + 開催状況(土日 or 中央開催の月曜)
 *   - 自分の AI 育成サマリ (★レベル, 直近回収率)
 *   - クイックアクションチップ (📝 手動入力 / 🎙 声 / 🎲 サンプル / 🎓 ツアー)
 *
 * シンプルに 1 カード。スクロール邪魔しない高さ。
 */

(function () {
  if (typeof window === "undefined") return;

  function $(s, r) { return (r || document).querySelector(s); }

  function timeGreeting() {
    const h = new Date().getHours();
    if (h < 5)  return { emoji: "🌙", text: "夜分にお疲れ様です" };
    if (h < 10) return { emoji: "☀️", text: "おはようございます" };
    if (h < 14) return { emoji: "🌞", text: "こんにちは" };
    if (h < 17) return { emoji: "🏇", text: "発走の時間です" };
    if (h < 21) return { emoji: "🌆", text: "こんばんは" };
    return { emoji: "🌙", text: "1 日お疲れ様でした" };
  }

  function fmtToday() {
    const d = new Date();
    const w = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
    return `${d.getMonth() + 1}月${d.getDate()}日(${w})`;
  }

  function quickStats() {
    // localStorage から軽く読み出す (この時点で他モジュールが書き込み済みでなくてもクラッシュさせない)
    try {
      const raw = localStorage.getItem("keiba_nav_v1");
      if (!raw) return { betsCount: 0, recentRecovery: null, sparkline: [] };
      const parsed = JSON.parse(raw);
      const bets = Array.isArray(parsed?.bets) ? parsed.bets : [];
      // dummy 除外 + 確定済のみ
      const real = bets.filter(b => b.dataSource !== "dummy" && (b.result?.won === true || b.result?.won === false));
      if (!real.length) return { betsCount: 0, recentRecovery: null, sparkline: [] };
      // 直近 30 件で回収率
      const recent = real.slice(-30);
      const totalStake = recent.reduce((s, b) => s + (Number(b.amount) || 0), 0);
      const totalPayout = recent.reduce((s, b) => s + (Number(b?.result?.payout) || 0), 0);
      const recovery = totalStake > 0 ? totalPayout / totalStake : null;
      // スパークライン: 直近 20 件の累積収支
      const sparkline = [];
      let cum = 0;
      const sparkSrc = real.slice(-20);
      for (const b of sparkSrc) {
        const profit = (Number(b?.result?.payout) || 0) - (Number(b.amount) || 0);
        cum += profit;
        sparkline.push(cum);
      }
      return { betsCount: real.length, recentRecovery: recovery, sparkline };
    } catch {
      return { betsCount: 0, recentRecovery: null, sparkline: [] };
    }
  }

  function aiLevelSummary() {
    try {
      if (!window.Learner) return null;
      const raw = localStorage.getItem("keiba_nav_v1");
      const parsed = raw ? JSON.parse(raw) : {};
      const bets = Array.isArray(parsed?.bets) ? parsed.bets : [];
      const stats = window.Learner.computeStats(bets);
      return { level: stats.level || 1, name: stats.levelName || "ひよこ AI" };
    } catch { return null; }
  }

  function render() {
    // 既にあれば差し替え
    let brief = document.getElementById("daily-brief");
    if (!brief) {
      brief = document.createElement("section");
      brief.id = "daily-brief";
      brief.className = "daily-brief";
      // hero-question の直前に挿入
      const hq = document.querySelector("#tab-home .hero-question");
      if (hq && hq.parentNode) {
        hq.parentNode.insertBefore(brief, hq);
      } else {
        // フォールバック: home タブの最初
        const home = document.getElementById("tab-home")?.querySelector(".max-w-2xl");
        if (home) home.insertBefore(brief, home.firstChild);
        else return;
      }
    }
    const g = timeGreeting();
    const today = fmtToday();
    const day = new Date().getDay();
    const isWeekend = day === 0 || day === 6;
    const ai = aiLevelSummary();
    const stats = quickStats();

    const recoveryStr = stats.recentRecovery == null
      ? "実績データ蓄積中"
      : (stats.recentRecovery * 100).toFixed(0) + "%";
    const recoveryCls = stats.recentRecovery == null
      ? "db-recovery-pending"
      : (stats.recentRecovery >= 1.0 ? "db-recovery-up" : "db-recovery-down");

    brief.innerHTML = `
      <div class="db-row1">
        <div class="db-greet">
          <span class="db-emoji">${g.emoji}</span>
          <span class="db-text">${g.text}</span>
        </div>
        <div class="db-date">${today}${isWeekend ? " <span class='db-weekend'>開催日</span>" : ""}</div>
      </div>
      <div class="db-row2">
        <div class="db-cell">
          <div class="db-key">育成 Lv.</div>
          <div class="db-val">${ai ? "★".repeat(ai.level) + "☆".repeat(5 - ai.level) : "★☆☆☆☆"}</div>
          <div class="db-sub">${ai ? ai.name : "ひよこ AI"}</div>
        </div>
        <div class="db-cell">
          <div class="db-key">直近回収率</div>
          <div class="db-val ${recoveryCls}">${recoveryStr}</div>
          <canvas id="db-spark" class="db-spark" width="120" height="22"></canvas>
          <div class="db-sub">${stats.betsCount} 件の確定済</div>
        </div>
      </div>
      <div class="db-quick">
        <button type="button" class="db-chip" id="db-act-sample">🎲 サンプル</button>
        <button type="button" class="db-chip" id="db-act-voice" hidden>🎙 声で入力</button>
        <button type="button" class="db-chip" id="db-act-manual">📝 手動入力</button>
        <button type="button" class="db-chip" id="db-act-tour">🎓 ツアー</button>
      </div>
    `;

    // スパークライン描画 (Achievements とも共通の累積収支 last 20)
    const sparkCanvas = $("#db-spark", brief);
    if (sparkCanvas && stats.sparkline?.length >= 2 && window.KNAnim?.drawSparkline) {
      try { window.KNAnim.drawSparkline(sparkCanvas, stats.sparkline, { positive: 0 }); } catch {}
    } else if (sparkCanvas) {
      sparkCanvas.style.display = "none";
    }

    // ハンドラ
    $("#db-act-sample", brief)?.addEventListener("click", () => {
      document.getElementById("mi-demo")?.click();
    });
    $("#db-act-manual", brief)?.addEventListener("click", () => {
      const det = document.getElementById("manual-input-section");
      if (det) det.open = true;
      document.getElementById("mi-textarea")?.focus();
      document.getElementById("mi-textarea")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    $("#db-act-tour", brief)?.addEventListener("click", () => {
      if (window.KNOnboarding) {
        window.KNOnboarding.reset();
        window.KNOnboarding.start();
      }
    });
    const voiceChip = $("#db-act-voice", brief);
    if (voiceChip && window.KNVoiceInput?.supported) {
      voiceChip.hidden = false;
      voiceChip.addEventListener("click", () => window.KNVoiceInput.start());
    }
  }

  // 初回描画 + 5 分ごと再描画 (時間帯と統計の更新のため)
  function init() {
    render();
    setInterval(render, 5 * 60 * 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  window.KNDailyBrief = { render };
})();
