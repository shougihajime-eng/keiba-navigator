"use strict";
// 更新スケジューラ設定 (利用規約遵守 + 発走時刻に応じた可変頻度)
//
// 実際の自動 fetch ループは jv_bridge/jv_fetch.py の watch モードで動かす。
// この lib は「次回更新までの推奨間隔」を返すだけ(クライアントの自動更新判定にも使える)。

// JRA-VAN 利用規約・JV-Link 仕様の更新間隔を尊重するため、
// オッズ更新頻度はおおむね1分以上の間隔を確保する。

const PHASE_INTERVAL_SEC = {
  idle:        30 * 60,   // 発走から1時間以上前 / 発走時刻不明
  t60:          5 * 60,   // 発走 60-30分前
  t30:          2 * 60,   // 発走 30-10分前
  t10:               60,  // 発走 10分前 - 直前 (最重要監視)
  during:            30,  // 発走から +15分以内
  after:       30 * 60,   // 発走後15分以降
};

function determinePhase(raceStartIso, nowIso = null) {
  if (!raceStartIso) return "idle";
  const now = new Date(nowIso || new Date()).getTime();
  const start = new Date(raceStartIso).getTime();
  if (isNaN(start)) return "idle";
  const diffSec = (start - now) / 1000;
  if (diffSec >  60 * 60)        return "idle";
  if (diffSec >  30 * 60)        return "t60";
  if (diffSec >  10 * 60)        return "t30";
  if (diffSec >  -1 * 60)        return "t10";
  if (diffSec > -15 * 60)        return "during";
  return "after";
}

function recommendNextUpdate(raceStartIso, nowIso = null) {
  const phase = determinePhase(raceStartIso, nowIso);
  const sec = PHASE_INTERVAL_SEC[phase] ?? PHASE_INTERVAL_SEC.idle;
  return { phase, intervalSec: sec, nextAt: new Date(Date.now() + sec * 1000).toISOString() };
}

module.exports = { determinePhase, recommendNextUpdate, PHASE_INTERVAL_SEC };
