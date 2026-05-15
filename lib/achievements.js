"use strict";

/*
 * lib/achievements.js — マイルストーン達成バッジ
 *
 * 「いつのまにか自分が成長してる」と気づける、ふわっとした楽しさ。
 * 嫌味じゃなく、温かいゲーミフィケーション。
 *
 * バッジ条件:
 *   - first_bet     初めての記録
 *   - first_real    初めてのリアル馬券
 *   - air_10        エア馬券 10 件
 *   - real_10       リアル馬券 10 件
 *   - bets_100      累計 100 件
 *   - hit_first     初めての的中
 *   - hit_5_streak  5連勝
 *   - profit_first  通算プラス達成 (確定済のみ)
 *   - profit_10pct  回収率 110% 超 (50件以上で評価)
 *   - calibrated    自己校正が10件以上溜まったグレード初発生
 *   - tour_done     チュートリアル完走
 *   - voice_used    音声入力を使った
 *   - share_done    1 回シェアした
 *   - level_3       ★3 到達
 *   - level_5       ★5 世界クラス
 *
 * 仕組み:
 *   - 取得済バッジは localStorage 'kn_achievements_v1' に { id: ts } 形式で蓄積
 *   - evaluate() を任意のタイミングで呼ぶ → 新規取得は登録 + 演出
 *   - 「達成しました!」のトーストと、設定タブのバッジ一覧で確認可能
 */

(function () {
  if (typeof window === "undefined") return;

  const LS_KEY = "kn_achievements_v1";

  const ALL_BADGES = [
    { id: "first_bet",     emoji: "🎬", title: "デビュー戦",        body: "初めての記録を残しました" },
    { id: "first_real",    emoji: "💵", title: "リアル参戦",        body: "初めてのリアル馬券を記録" },
    { id: "air_10",        emoji: "🧪", title: "エア 10 戦",        body: "エア馬券 10 件突破" },
    { id: "real_10",       emoji: "💰", title: "リアル 10 戦",      body: "リアル馬券 10 件突破" },
    { id: "bets_100",      emoji: "🏇", title: "100 戦の風",        body: "累計 100 件の記録" },
    { id: "hit_first",     emoji: "🎯", title: "初当たり",          body: "初めての的中" },
    { id: "hit_5_streak",  emoji: "🔥", title: "5 連勝",            body: "確定済 5 件連続で当たり" },
    { id: "profit_first",  emoji: "📈", title: "プラ転",            body: "通算収支がプラスに" },
    { id: "profit_10pct",  emoji: "🏆", title: "回収率 110%",       body: "50 件以上で回収率 110% 超" },
    { id: "calibrated",    emoji: "🧠", title: "自己校正発動",      body: "1 グレードで 10 件以上の実績を蓄積" },
    { id: "tour_done",     emoji: "🎓", title: "ツアー完走",        body: "初回ガイドを最後まで見た" },
    { id: "voice_used",    emoji: "🎙", title: "声で入力",          body: "音声入力を 1 回使った" },
    { id: "share_done",    emoji: "📤", title: "つながる",          body: "AI 判定を 1 回シェア" },
    { id: "level_3",       emoji: "⭐", title: "★3 到達",           body: "AI 育成 Lv.3 へ昇格" },
    { id: "level_5",       emoji: "🌟", title: "世界クラス AI",    body: "★5 / 500件+ / 回収率100%超" },
  ];

  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return {};
      return JSON.parse(raw) || {};
    } catch { return {}; }
  }

  function save(data) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch {}
  }

  function isUnlocked(id) {
    return !!load()[id];
  }

  function unlock(id) {
    if (isUnlocked(id)) return false;
    const data = load();
    data[id] = new Date().toISOString();
    save(data);
    celebrate(id);
    return true;
  }

  function getBadge(id) { return ALL_BADGES.find(b => b.id === id); }

  function celebrate(id) {
    const b = getBadge(id);
    if (!b) return;
    if (typeof window.showToast === "function") {
      window.showToast(`${b.emoji} 達成: ${b.title}`, "ok");
    }
    if (typeof window.fireConfetti === "function") {
      try { window.fireConfetti(0.6); } catch {}
    }
    // 浮かんでくるバナー
    showBanner(b);
  }

  function showBanner(b) {
    const old = document.getElementById("kn-ach-banner");
    if (old) old.remove();
    const div = document.createElement("div");
    div.id = "kn-ach-banner";
    div.className = "kn-ach-banner";
    div.innerHTML = `
      <div class="kn-ach-emoji">${b.emoji}</div>
      <div class="kn-ach-text">
        <div class="kn-ach-label">🏅 達成</div>
        <div class="kn-ach-title">${b.title}</div>
        <div class="kn-ach-body">${b.body}</div>
      </div>
    `;
    document.body.appendChild(div);
    setTimeout(() => div.classList.add("kn-ach-show"), 20);
    setTimeout(() => {
      div.classList.remove("kn-ach-show");
      setTimeout(() => div.remove(), 400);
    }, 3600);
  }

  // ─── 評価関数 (任意のタイミングで呼ぶ・冪等) ──────────────
  function evaluate() {
    try {
      const raw = localStorage.getItem("keiba_nav_v1");
      const parsed = raw ? JSON.parse(raw) : {};
      const bets = Array.isArray(parsed?.bets) ? parsed.bets : [];
      const real = bets.filter(b => b.dataSource !== "dummy");

      const confirmed = real.filter(b => b.result?.won === true || b.result?.won === false);
      const wins = confirmed.filter(b => b.result?.won === true);
      const airs = real.filter(b => b.type === "air");
      const reals = real.filter(b => b.type === "real");

      if (real.length >= 1)   unlock("first_bet");
      if (reals.length >= 1)  unlock("first_real");
      if (airs.length >= 10)  unlock("air_10");
      if (reals.length >= 10) unlock("real_10");
      if (real.length >= 100) unlock("bets_100");
      if (wins.length >= 1)   unlock("hit_first");

      // 5 連勝 (確定済の最後 5 件が全部 won=true)
      if (confirmed.length >= 5) {
        const last5 = confirmed.slice(-5);
        if (last5.every(b => b.result?.won === true)) unlock("hit_5_streak");
      }

      // 通算収支プラス
      if (confirmed.length >= 1) {
        const stake = confirmed.reduce((s, b) => s + (Number(b.amount) || 0), 0);
        const pay   = confirmed.reduce((s, b) => s + (Number(b?.result?.payout) || 0), 0);
        if (pay - stake > 0) unlock("profit_first");
        if (confirmed.length >= 50 && stake > 0 && (pay / stake) >= 1.10) unlock("profit_10pct");
      }

      // 自己校正発動
      try {
        if (window.Learner) {
          const calib = window.Learner.computeCalibration(real);
          if (calib && Object.values(calib).some(c => c.samples >= 10)) {
            unlock("calibrated");
          }
        }
      } catch {}

      // AI Level
      try {
        if (window.Learner) {
          const stats = window.Learner.computeStats(real);
          if (stats?.level >= 3) unlock("level_3");
          if (stats?.level >= 5) unlock("level_5");
        }
      } catch {}

      // ツアー完走
      try {
        if (localStorage.getItem("kn_onboarded_v1") === "done") unlock("tour_done");
      } catch {}
    } catch (e) {
      console.warn("[achievements] evaluate failed", e);
    }
  }

  // 起動 → 評価
  function init() {
    setTimeout(evaluate, 1500);
    // 5 分ごと再評価 (記録の更新を拾うため)
    setInterval(evaluate, 5 * 60 * 1000);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  // 外から呼べる API
  window.KNAchievements = {
    unlock,
    isUnlocked,
    evaluate,
    getAll: () => ALL_BADGES.map(b => ({ ...b, unlockedAt: load()[b.id] || null })),
    reset: () => save({}),
  };
})();
