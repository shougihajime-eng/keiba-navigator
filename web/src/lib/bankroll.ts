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

/** 1レースの目安額: 予算の3%・100円単位・最低100円 (使用箇所が残るため互換維持) */
export function perRaceUnit(budget: number): number {
  return Math.max(100, Math.round((budget * 0.03) / 100) * 100);
}

/**
 * 買う金額のルール (本人が決めた固定額・2026-05-30):
 *   勝負 (普通に買うレース) = 5,000円
 *   絶好機 (自信のあるレース) = 15,000円 (1万〜1万5千円の上限)
 *   様子見 / 見送り = 買わない (0円)
 * WIN5 は金額を決めず、自信のあるときだけ買う (本人判断)。
 */
export const STAKE_PLAN = { prime: 15000, bet: 5000 } as const;
export const STAKE_PRIME_LOW = 10000; // 絶好機の下限 (1万円)

/** 段階(tier)ごとの「複勝」おすすめ金額。本人が決めた固定額。 */
export function fukushoStake(tier: "prime" | "bet" | "watch" | "skip", _budget?: number): number {
  if (tier === "prime") return STAKE_PLAN.prime;
  if (tier === "bet") return STAKE_PLAN.bet;
  return 0;
}
