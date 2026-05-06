"use strict";

/**
 * Kelly 基準による推奨賭け金 (Half Kelly)
 *
 * 期待値プラスでも「いくら買うか」を間違えると破産する。
 * Kelly 公式 f_star = (bp - q) / b で長期成長率を最大化。
 * 実運用では分散低減のため Half Kelly (f_star / 2) を使う (業界標準)。
 *
 * 入力:
 *   prob:        推定勝率 (補正後 calibrated_prob 推奨)
 *   odds:        オッズ (倍率)
 *   bankroll:    賭け原資 (1日予算など)
 *   perRaceCap:  1レース上限 (任意・設定値)
 *
 * 出力:
 *   { stake: 推奨額(100円単位), fraction: 賭ける比率, reason }
 *
 * ルール:
 *   - prob*odds <= 1 (期待値マイナス) → stake = 0 (買うな)
 *   - 信頼度 confidence < 0.20 → Quarter Kelly (1/4) で更に保守的
 *   - 100円単位に floor
 *   - perRaceCap でクリップ
 */

function kellyFraction(prob, odds) {
  if (!Number.isFinite(prob) || !Number.isFinite(odds)) return 0;
  if (prob <= 0 || prob >= 1 || odds <= 1) return 0;
  const b = odds - 1;
  const q = 1 - prob;
  const f = (b * prob - q) / b;
  return Math.max(0, f);
}

function suggestStake({ prob, odds, bankroll, perRaceCap, confidence }) {
  const ev = (prob != null && odds != null) ? prob * odds : null;
  if (ev == null || ev <= 1.0) {
    return { stake: 0, fraction: 0, ev, reason: "期待値マイナス・買うべきでない" };
  }
  if (!bankroll || bankroll <= 0) {
    return { stake: 0, fraction: 0, ev, reason: "予算未設定 (設定タブで1日予算を入れてください)" };
  }
  const f = kellyFraction(prob, odds);
  if (f <= 0) {
    return { stake: 0, fraction: 0, ev, reason: "オッズに対して推定勝率が低すぎる" };
  }
  // 信頼度低 → Quarter Kelly、それ以外 → Half Kelly
  const conservatism = (typeof confidence === "number" && confidence < 0.20) ? 0.25 : 0.5;
  const safeFrac = f * conservatism;
  let raw = bankroll * safeFrac;
  if (perRaceCap && perRaceCap > 0) raw = Math.min(raw, perRaceCap);
  // 100円単位に floor。最低100円。
  let stake = Math.floor(raw / 100) * 100;
  if (raw > 0 && stake < 100) stake = 100;  // 1口は最低100円
  if (perRaceCap && perRaceCap > 0) stake = Math.min(stake, perRaceCap);

  let reason;
  if (conservatism === 0.25) reason = `信頼度低のため Quarter Kelly (${(safeFrac*100).toFixed(1)}%)`;
  else                       reason = `Half Kelly (${(safeFrac*100).toFixed(1)}%)`;

  return { stake, fraction: safeFrac, ev, reason };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { kellyFraction, suggestStake };
}
if (typeof window !== "undefined") {
  window.Kelly = { kellyFraction, suggestStake };
}
