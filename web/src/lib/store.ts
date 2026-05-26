// ローカル馬券保管。既存アプリ (keiba_v15) と読み取り互換を保つ
"use client";

const STORE_KEY = "keiba_v2";
const LEGACY_KEY = "keiba_v15";

export type Bet = {
  id: string;
  raceId?: string;
  raceName?: string;
  course?: string;
  startTime?: string;
  type: string; // 単勝 / 複勝 / 馬連 / ワイド / 3連複 / 3連単 / ...
  horses: string; // "5" or "5-7" or "5-7-9"
  amount: number; // 投資額
  payout?: number; // 払戻金
  result?: "hit" | "miss" | "pending" | null;
  ev?: number;
  factors?: Record<string, unknown>;
  createdAt: string; // ISO
  isDraft?: boolean; // Phase 3 「これ買う」で下書き保存される
};

export function loadBets(): Bet[] {
  if (typeof window === "undefined") return [];
  try {
    const v2 = window.localStorage.getItem(STORE_KEY);
    if (v2) {
      const arr = JSON.parse(v2);
      if (Array.isArray(arr)) return arr;
    }
    const legacy = window.localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const arr = JSON.parse(legacy);
      if (Array.isArray(arr)) return arr;
    }
  } catch (err) {
    console.warn("[store] load failed", err);
  }
  return [];
}

export function saveBets(bets: Bet[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(bets));
  } catch (err) {
    console.warn("[store] save failed", err);
  }
}

export function addBet(bet: Bet) {
  const bets = loadBets();
  bets.push(bet);
  saveBets(bets);
}

export function updateBet(id: string, patch: Partial<Bet>) {
  const bets = loadBets().map((b) => (b.id === id ? { ...b, ...patch } : b));
  saveBets(bets);
}

export function deleteBet(id: string) {
  const bets = loadBets().filter((b) => b.id !== id);
  saveBets(bets);
}

// ============ 集計 ============

export type Summary = {
  count: number;
  hitCount: number;
  missCount: number;
  pendingCount: number;
  totalStake: number;
  totalPayout: number;
  profit: number;
  roi: number; // 0-200 (%)
};

function summarizeBets(bets: Bet[]): Summary {
  const s: Summary = {
    count: bets.length, hitCount: 0, missCount: 0, pendingCount: 0,
    totalStake: 0, totalPayout: 0, profit: 0, roi: 0,
  };
  for (const b of bets) {
    s.totalStake += Number(b.amount) || 0;
    s.totalPayout += Number(b.payout) || 0;
    if (b.result === "hit") s.hitCount += 1;
    else if (b.result === "miss") s.missCount += 1;
    else s.pendingCount += 1;
  }
  s.profit = s.totalPayout - s.totalStake;
  s.roi = s.totalStake > 0 ? (s.totalPayout / s.totalStake) * 100 : 0;
  return s;
}

export function summaryToday(bets: Bet[] = loadBets()): Summary {
  const today = new Date().toISOString().slice(0, 10);
  return summarizeBets(bets.filter((b) => (b.createdAt || "").slice(0, 10) === today));
}

export function summaryLast7Days(bets: Bet[] = loadBets()): Summary {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return summarizeBets(bets.filter((b) => (b.createdAt || "") >= since));
}

export function summaryAll(bets: Bet[] = loadBets()): Summary {
  return summarizeBets(bets);
}

export function summaryThisMonth(bets: Bet[] = loadBets()): Summary {
  const ym = new Date().toISOString().slice(0, 7); // YYYY-MM
  return summarizeBets(bets.filter((b) => (b.createdAt || "").slice(0, 7) === ym));
}

/** 最近外したレースを 1 件返す (反省カード用) */
export function latestMiss(bets: Bet[] = loadBets()): Bet | null {
  for (let i = bets.length - 1; i >= 0; i -= 1) {
    if (bets[i].result === "miss") return bets[i];
  }
  return null;
}
