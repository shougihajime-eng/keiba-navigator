"use client";

// 資金管理: 月の予算を localStorage に保存。儲かる買い方は無いので
// 「決めた額以上は使わない・1回は小さく」を支えるための最小限の道具。

const BUDGET_KEY = "keiba_budget_v1";
const DEFAULT_BUDGET = 10000;

export function getBudget(): number {
  if (typeof window === "undefined") return DEFAULT_BUDGET;
  try {
    const v = window.localStorage.getItem(BUDGET_KEY);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET;
  } catch {
    return DEFAULT_BUDGET;
  }
}

export function setBudget(yen: number) {
  if (typeof window === "undefined") return;
  try {
    const n = Math.max(0, Math.round(yen));
    window.localStorage.setItem(BUDGET_KEY, String(n));
    window.dispatchEvent(new Event("keiba:budget-changed"));
  } catch {
    /* ignore */
  }
}

/** 1レースの目安額: 予算の3%・100円単位・最低100円 (当たらない前提で小さく) */
export function perRaceUnit(budget: number): number {
  return Math.max(100, Math.round((budget * 0.03) / 100) * 100);
}

/**
 * 段階(tier)ごとの「複勝」おすすめ金額。儲かる買い方は無い前提なので
 * 絶好機=1レースの目安額・勝負=その7割 と、損を抑える小額に固定。
 * 様子見/見送りは買わない(0円)。100円単位。
 */
export function fukushoStake(tier: "prime" | "bet" | "watch" | "skip", budget: number): number {
  const unit = perRaceUnit(budget);
  if (tier === "prime") return unit;
  if (tier === "bet") return Math.max(100, Math.round((unit * 0.7) / 100) * 100);
  return 0;
}
