"use strict";

/**
 * KEIBA NAVIGATOR — レースクロック (Wave12)
 *
 * 役割:
 *   1) 各レースの発走時刻 (startAt) を監視
 *   2) T-10 分 / T-5 分 / T-0 (発走) の各タイミングで onTick イベント発火
 *   3) 重複発火しないように 1 レース x 1 タイミングで 1 回だけ
 *   4) アクティブタブ時のみ動作 (バックグラウンドは Service Worker 通知で別途処理)
 *
 * イベント受信側 (app.js) で:
 *   - T-10/T-5 時に該当レースのオッズを再取得 → 結論を再計算 → 保存
 *   - 通知 ON なら NotifyV2 経由でローカル通知
 *
 * 公開 API:
 *   RaceClock.register(race)              レース情報を登録
 *   RaceClock.unregister(raceId)
 *   RaceClock.onTick(fn)                  T-10/T-5/T-0 で fn({race, marker, minLeft}) が呼ばれる
 *   RaceClock.next()                      最も近い未来のレースを返す
 *   RaceClock.start()                     監視開始 (DOMContentLoaded で呼ぶ)
 */

(function (global) {
  const FIRED_KEY = "keiba_clock_fired_v1";
  const MARKERS = [
    { id: "t-10", minLeft: 10, label: "10分前" },
    { id: "t-5",  minLeft: 5,  label: "5分前"  },
    { id: "t-0",  minLeft: 0,  label: "発走"   },
  ];

  let registry = new Map();      // raceId -> {race, startAt: ms}
  let listeners = [];
  let _timer = null;

  function _loadFired() {
    try { return JSON.parse(localStorage.getItem(FIRED_KEY) || "{}"); }
    catch { return {}; }
  }
  function _saveFired(map) {
    try { localStorage.setItem(FIRED_KEY, JSON.stringify(map)); } catch {}
  }
  function _firedKey(raceId, marker) { return raceId + "::" + marker; }

  function _toMs(startAt) {
    if (!startAt) return NaN;
    if (typeof startAt === "number") return startAt;
    if (startAt instanceof Date) return startAt.getTime();
    const t = new Date(startAt).getTime();
    return Number.isFinite(t) ? t : NaN;
  }

  function register(race) {
    if (!race) return;
    const rid = race.id || race.raceId || race.conclusion?.raceMeta?.raceId || race.race_id;
    const start = _toMs(race.startAt || race.start_at || race.conclusion?.startAt || race.conclusion?.raceMeta?.hassouTime);
    if (!rid || !Number.isFinite(start)) return;
    registry.set(rid, { race, startAt: start, name: race.raceName || race.race_name || race.conclusion?.raceName || rid });
  }

  function unregister(raceId) {
    registry.delete(raceId);
  }

  function onTick(fn) { if (typeof fn === "function") listeners.push(fn); }

  function next() {
    const now = Date.now();
    let best = null;
    for (const [rid, slot] of registry) {
      if (slot.startAt - now < -5 * 60 * 1000) continue; // 発走から 5 分以上経過は除外
      if (!best || slot.startAt < best.startAt) {
        best = { raceId: rid, ...slot };
      }
    }
    return best;
  }

  function _check() {
    const now = Date.now();
    const fired = _loadFired();
    let changed = false;
    for (const [rid, slot] of registry) {
      const minLeft = (slot.startAt - now) / 60000;
      for (const m of MARKERS) {
        const key = _firedKey(rid, m.id);
        // マーカーに「入ってから 90 秒以内」のウィンドウで発火 (ぴったり 0 通過を取り逃さない)
        const target = m.minLeft;
        const inWindow = minLeft <= target + 1 && minLeft >= target - 1;
        if (inWindow && !fired[key]) {
          fired[key] = now;
          changed = true;
          for (const fn of listeners) {
            try { fn({ raceId: rid, race: slot.race, marker: m.id, label: m.label, minLeft, startAt: slot.startAt }); } catch (e) { console.warn("[race_clock listener]", e); }
          }
        }
      }
    }
    if (changed) _saveFired(fired);
  }

  function start() {
    if (_timer) return;
    _timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      _check();
    }, 30 * 1000);
    // 起動直後に 1 回
    setTimeout(_check, 1500);
  }

  function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
  }

  // すべて消す (デバッグ用)
  function reset() { registry.clear(); _saveFired({}); }

  global.RaceClock = { register, unregister, onTick, next, start, stop, reset, _internal: { registry, MARKERS } };
})(typeof window !== "undefined" ? window : globalThis);
