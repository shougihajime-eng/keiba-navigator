"use strict";

/**
 * KEIBA NAVIGATOR — 通知細分化レイヤー (Wave11)
 *
 * 通知タイプ:
 *   morning_best1     朝のベスト1 (06:00-12:00, 1日1回)
 *   prerace_10min     発走 10 分前 (保存済レースで発走時刻が分かるもの)
 *   win5_start        WIN5 第1R 発走前
 *   result_announce   結果配信 (払戻決定後)
 *
 * 各タイプは独立して ON/OFF 可能。設定は localStorage に保存。
 *
 * 公開 API:
 *   NotifyV2.isEnabled(type) -> bool
 *   NotifyV2.setEnabled(type, bool)
 *   NotifyV2.types -> 型一覧 (UI 生成用)
 *   NotifyV2.runChecks() -> 各タイプの条件を見て通知を出す (1 分ごと呼出想定)
 */

(function (global) {
  const KEY_PREFIX = "keiba_notify_v2_";

  const TYPES = [
    {
      id: "morning_best1",
      label: "🏆 朝のベスト1",
      desc: "朝 6 時〜12 時にアプリを開いた時、今日の本命をプッシュ",
      defaultOn: true,
    },
    {
      id: "prerace_10min",
      label: "🏇 発走 10 分前",
      desc: "保存済レースの発走時刻が近づいたら通知 (オッズ変動チェック用)",
      defaultOn: true,
    },
    {
      id: "win5_start",
      label: "🎰 WIN5 開始 (1R前)",
      desc: "WIN5 第1R の発走前にまとめ通知",
      defaultOn: true,
    },
    {
      id: "result_announce",
      label: "💰 結果配信",
      desc: "払戻が確定したらレース結果と的中可否を通知",
      defaultOn: false,
    },
  ];

  function key(type) { return KEY_PREFIX + type; }

  function isEnabled(type) {
    const t = TYPES.find(x => x.id === type);
    const stored = localStorage.getItem(key(type));
    if (stored === "1") return true;
    if (stored === "0") return false;
    return t ? t.defaultOn : false;
  }

  function setEnabled(type, on) {
    try { localStorage.setItem(key(type), on ? "1" : "0"); } catch {}
  }

  // 最終発火時刻を記憶 (重複発火防止)
  const FIRED_KEY = (type, raceId) => `${key(type)}_fired_${raceId || "default"}`;
  function alreadyFired(type, raceId, withinMs = 6 * 60 * 60 * 1000) {
    try {
      const last = localStorage.getItem(FIRED_KEY(type, raceId));
      if (!last) return false;
      return (Date.now() - Number(last)) < withinMs;
    } catch { return false; }
  }
  function markFired(type, raceId) {
    try { localStorage.setItem(FIRED_KEY(type, raceId), String(Date.now())); } catch {}
  }

  async function showNotif(title, body, tag) {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    try {
      const reg = navigator.serviceWorker ? await navigator.serviceWorker.ready : null;
      if (reg && reg.showNotification) {
        reg.showNotification(title, { body, icon: "/icon.svg", badge: "/icon.svg", tag: tag || "keiba" });
      } else {
        new Notification(title, { body, icon: "/icon.svg" });
      }
    } catch (e) { console.warn("[notify_v2] failed", e); }
  }

  // ─── 各タイプの判定ロジック ───────────────────────────
  async function checkMorningBest1() {
    if (!isEnabled("morning_best1")) return;
    const now = new Date();
    const hour = now.getHours();
    if (hour < 6 || hour >= 12) return;
    const today = now.toISOString().slice(0, 10);
    if (alreadyFired("morning_best1", today, 24 * 60 * 60 * 1000)) return;
    // app.js 側の loadSavedRaces / calibratedTopEv を借りる
    const races = (typeof loadSavedRaces === "function") ? loadSavedRaces() : [];
    if (!races.length) return;
    const ranked = races.map(r => ({
      ...r,
      ev: (typeof calibratedTopEv === "function") ? calibratedTopEv(r.conclusion) : (r.conclusion?.picks?.[0]?.ev || null),
    })).filter(r => Number.isFinite(r.ev)).sort((a, b) => b.ev - a.ev);
    const best = ranked[0];
    if (!best) return;
    const top = best.conclusion?.picks?.[0];
    if (!top) return;
    const sign = best.ev >= 1 ? "+" : "";
    const evPct = ((best.ev - 1) * 100).toFixed(0);
    await showNotif(
      `🏆 今日のベスト1: ${best.raceName || "保存レース"}`,
      `${top.number || "?"}番 ${top.name || ""} / 補正後EV ${sign}${evPct}% / ${top.odds ?? "?"}倍`,
      "keiba-best1-" + today,
    );
    markFired("morning_best1", today);
  }

  async function checkPrerace10min() {
    if (!isEnabled("prerace_10min")) return;
    const races = (typeof loadSavedRaces === "function") ? loadSavedRaces() : [];
    for (const r of races) {
      const start = r.startAt || r.conclusion?.startAt || r.conclusion?.raceMeta?.hassouTime;
      if (!start) continue;
      const startMs = new Date(start).getTime();
      if (!Number.isFinite(startMs)) continue;
      const min = (startMs - Date.now()) / 60000;
      if (min < 8 || min > 12) continue;  // 8-12 分前のウィンドウ
      const rid = r.id || r.conclusion?.raceMeta?.raceId || r.raceName;
      if (alreadyFired("prerace_10min", rid)) continue;
      const top = r.conclusion?.picks?.[0];
      const tag = `keiba-prerace-${rid}`;
      const horseText = top ? `本命 ${top.number || "?"}番 ${top.name || ""} (${top.odds ?? "?"}倍)` : "";
      await showNotif(
        `🏇 もうすぐ発走: ${r.raceName || "レース"}`,
        `あと ${Math.round(min)} 分。${horseText}`,
        tag,
      );
      markFired("prerace_10min", rid);
    }
  }

  async function checkWin5Start() {
    if (!isEnabled("win5_start")) return;
    // WIN5 候補レース = 日曜の保存済レース最初の 5 件
    const races = (typeof loadSavedRaces === "function") ? loadSavedRaces() : [];
    const sun = races.filter(r => {
      const t = new Date(r.createdAt || 0);
      return t.getDay() === 0;
    }).slice(0, 5);
    if (sun.length < 5) return;
    const firstStart = sun[0].startAt || sun[0].conclusion?.startAt;
    if (!firstStart) return;
    const ms = new Date(firstStart).getTime();
    if (!Number.isFinite(ms)) return;
    const min = (ms - Date.now()) / 60000;
    if (min < 25 || min > 35) return;
    const today = new Date().toISOString().slice(0, 10);
    if (alreadyFired("win5_start", today, 24 * 60 * 60 * 1000)) return;
    const win5 = (window.Win5 && typeof window.Win5.compute === "function")
      ? window.Win5.compute(sun.map(r => r.conclusion).filter(Boolean))
      : null;
    const body = win5
      ? `5R フォーメーション ${win5.formation.cells}点 ${win5.formation.cost}円 / 連勝率 ${win5.combined.probAllWinPct} / ${win5.stake.narrative}`
      : `WIN5 候補 5 レース判定済`;
    await showNotif("🎰 まもなく WIN5 開始", body, "keiba-win5-" + today);
    markFired("win5_start", today);
  }

  async function checkResultAnnounce() {
    if (!isEnabled("result_announce")) return;
    // 「結果待ち」記録に対し、results JSON が見えるようになったら通知
    // 実装簡略: 直近 6 時間以内に won 状態が変化した bet を検出
    try {
      const store = (typeof loadStore === "function") ? loadStore() : null;
      if (!store?.bets) return;
      const recent = store.bets.filter(b =>
        b.result?.finishedAt &&
        (Date.now() - new Date(b.result.finishedAt).getTime()) < 6 * 60 * 60 * 1000
      );
      for (const b of recent) {
        const tag = `keiba-result-${b.id}`;
        if (alreadyFired("result_announce", b.id, 7 * 24 * 60 * 60 * 1000)) continue;
        const won = b.won === true;
        await showNotif(
          won ? "🎉 的中！" : "🥲 残念...",
          `${b.target} / ${won ? `+${b.result?.payout?.toLocaleString() || "?"}円` : "次に期待"}`,
          tag,
        );
        markFired("result_announce", b.id);
      }
    } catch (e) { console.warn(e); }
  }

  async function runChecks() {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    await checkMorningBest1();
    await checkPrerace10min();
    await checkWin5Start();
    await checkResultAnnounce();
  }

  // 1 分ごとに自動チェック
  let _timer = null;
  function startAutoChecks() {
    if (_timer) return;
    _timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      runChecks().catch(() => {});
    }, 60 * 1000);
    // 起動時に 1 回
    setTimeout(() => runChecks().catch(() => {}), 3000);
  }

  global.NotifyV2 = { types: TYPES, isEnabled, setEnabled, runChecks, startAutoChecks };
})(typeof window !== "undefined" ? window : globalThis);
