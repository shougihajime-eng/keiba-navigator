// 既存 /api/races・/api/recommendations 等のレスポンス型
// keiba-navigator.vercel.app の Vercel Functions が返す形

export type HorsePick = {
  number: number;
  name: string;
  odds?: number | null;
  ev?: number | null;
  grade?: string | null;
  prob?: number | null;
};

export type RaceSummary = {
  raceName: string | null;
  raceId: string | null;
  course: string | null;
  venue: string | null;
  surface: string | null;
  distance: number | null;
  startTime: string | null;
  isDummy: boolean;
  isG1: boolean;
  verdict?: "go" | "neutral" | "pass" | "loading" | null;
  verdictTitle?: string | null;
  topGrade?: string | null;
  topPick?: HorsePick | null;
  second?: HorsePick | null;
  third?: HorsePick | null;
  confidence?: number | null;
  hasOverpop?: boolean;
  hasUnderval?: boolean;
  trackBiasNote?: string | null;
  horseCount?: number;
};

export type RacesResponse = {
  ok: boolean;
  fetchedAt?: string;
  source?: "precomputed" | "no_today" | string;
  computedAt?: string;
  raceCount?: number;
  races?: RaceSummary[];
  reason?: string;
  learning?: Record<string, unknown> | null;
};

export type Recommendation = {
  raceId: string;
  raceName?: string;
  course?: string;
  startTime?: string;
  horse?: { number: number; name: string };
  stake?: number;
  payout?: number;
  result?: "hit" | "miss" | null;
  ev?: number;
  strategies?: string[];
  fired?: { type: string; horse: number }[];
};

export type RecommendationsResponse = {
  ok: boolean;
  fetchedAt?: string;
  recommendations?: Recommendation[];
  recommendations_fallback?: Recommendation[];
  count_today?: number;
  count_recent?: number;
  reason?: string;
};

export type StatusResponse = {
  ok: boolean;
  ts?: string;
  status?: string;
  message?: string;
  raceCount?: number;
};

// 実験室 (自己成長する実験モード) のレスポンス型
export type ExperimentStrategy = {
  key: string;
  name: string;
  desc: string;
  origin: string;
  bet_type: string;
  bets: number;
  hit_rate_pct: number | null;
  roi_pct: number | null;
  profit_yen: number;
  win_periods: number;
  active_periods: number;
  period_rois: (number | null)[];
  bankroll_curve: number[];
  is_winning: boolean;
};

export type ExperimentStatusResponse = {
  ok: boolean;
  updated_at?: string;
  leakage_free?: boolean;
  total_bet_records?: number;
  periods?: number;
  start_bankroll?: number;
  unit_yen?: number;
  any_winning_strategy?: boolean;
  headline?: string;
  champion_key?: string | null;
  strategies?: ExperimentStrategy[];
  note?: string;
  reason?: string;
};

// Block B 反省履歴用 — Phase 4 で本実装。今は型だけ
export type Reflection = {
  raceId: string;
  raceName?: string;
  course?: string;
  startTime?: string;
  bet?: { type: string; horses: string };
  prediction?: { topPick: string; expectedEV: number };
  result?: { positions: string[]; winningCombo: string };
  missReasonTags?: string[];
  freeText?: string;
  createdAt?: string;
};
