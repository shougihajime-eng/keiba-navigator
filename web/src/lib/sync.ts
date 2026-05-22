"use client";

// クラウド同期: localStorage <-> Supabase の双方向同期
// 戦略: last-write-wins (updated_at 比較)
// ログイン中だけ動作。未ログインは localStorage 単独。

import { getSupabase, currentUser } from "@/lib/supabase";
import { loadBets, saveBets, type Bet } from "@/lib/store";
import { loadReflections, saveReflection } from "@/lib/reflectionStore";
import type { StructuredReflection } from "@/lib/reflection";

const LAST_SYNC_KEY = "keiba.last-sync.v1";

export type SyncStatus = {
  enabled: boolean;
  lastSyncedAt: string | null;
  pendingBets: number;
  pendingRefs: number;
  error?: string;
};

export async function getSyncStatus(): Promise<SyncStatus> {
  const user = await currentUser();
  return {
    enabled: !!user,
    lastSyncedAt: window.localStorage.getItem(LAST_SYNC_KEY),
    pendingBets: 0,
    pendingRefs: 0,
  };
}

/**
 * Sync flow:
 * 1. Pull from server (bets + reflections)
 * 2. Merge with local (server wins on conflict — last_write_wins via updated_at)
 * 3. Push local-only items to server
 */
export async function runSync(): Promise<SyncStatus> {
  const user = await currentUser();
  if (!user) {
    return { enabled: false, lastSyncedAt: null, pendingBets: 0, pendingRefs: 0 };
  }
  const sb = getSupabase();

  // 1. Pull bets
  const betsRes = await sb
    .from("bets")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(2000);
  const serverBets = betsRes.data as ServerBet[] | null;
  if (betsRes.error) {
    console.warn("[sync] pull bets failed", betsRes.error);
    return { enabled: true, lastSyncedAt: null, pendingBets: 0, pendingRefs: 0, error: betsRes.error.message };
  }

  // 2. Pull reflections
  const refsRes = await sb
    .from("reflections")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(2000);
  const serverRefs = refsRes.data as ServerRef[] | null;
  if (refsRes.error) {
    console.warn("[sync] pull reflections failed", refsRes.error);
  }

  // 3. Merge bets
  const localBets = loadBets();
  const mergedBets = mergeBets(localBets, serverBets || []);
  saveBets(mergedBets);

  // 4. Merge reflections
  const localRefs = loadReflections();
  const mergedRefs = mergeReflections(localRefs, serverRefs || []);
  for (const r of mergedRefs) saveReflection(r);

  // 5. Push local-only items to server
  const remoteIds = new Set((serverBets || []).map((b) => b.id));
  const toPushBets = mergedBets.filter((b) => !remoteIds.has(b.id)).map((b) => betToRow(b, user.id));
  if (toPushBets.length > 0) {
    const { error } = await sb.from("bets").upsert(toPushBets, { onConflict: "id" });
    if (error) console.warn("[sync] push bets failed", error);
  }

  const remoteRefIds = new Set((serverRefs || []).map((r) => r.id));
  const toPushRefs = mergedRefs.filter((r) => !remoteRefIds.has(r.id)).map((r) => refToRow(r, user.id));
  if (toPushRefs.length > 0) {
    const { error } = await sb.from("reflections").upsert(toPushRefs, { onConflict: "id" });
    if (error) console.warn("[sync] push reflections failed", error);
  }

  const now = new Date().toISOString();
  window.localStorage.setItem(LAST_SYNC_KEY, now);
  window.dispatchEvent(new CustomEvent("keiba:synced"));

  return {
    enabled: true,
    lastSyncedAt: now,
    pendingBets: toPushBets.length,
    pendingRefs: toPushRefs.length,
  };
}

// ============ merge helpers ============

type ServerBet = {
  id: string;
  ts?: string;
  type?: string;
  amount?: number;
  race_name?: string;
  race_id?: string;
  target?: string;
  bet_type?: string;
  odds?: number;
  ev?: number;
  result?: { won?: boolean; payout?: number };
  profit?: number;
  auto_saved?: boolean;
  created_at?: string;
};

type ServerRef = {
  id: string;
  bet_id?: string;
  race_id?: string;
  race_name?: string;
  course?: string;
  tags?: string[];
  free_text?: string;
  weight_suggestion?: Record<string, string>;
  created_at?: string;
};

function mergeBets(local: Bet[], server: ServerBet[]): Bet[] {
  const map = new Map<string, Bet>();
  for (const b of local) map.set(b.id, b);
  for (const s of server) {
    const localBet = map.get(s.id);
    const serverBet = rowToBet(s);
    if (!localBet) {
      map.set(s.id, serverBet);
    } else {
      // last-write-wins: prefer the one with later createdAt
      const lt = Date.parse(localBet.createdAt || "1970");
      const st = Date.parse(serverBet.createdAt || "1970");
      map.set(s.id, st >= lt ? serverBet : localBet);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function mergeReflections(local: StructuredReflection[], server: ServerRef[]): StructuredReflection[] {
  const map = new Map<string, StructuredReflection>();
  for (const r of local) map.set(r.id, r);
  for (const s of server) {
    const localRef = map.get(s.id);
    const serverRef = rowToRef(s);
    if (!localRef) map.set(s.id, serverRef);
    else {
      const lt = Date.parse(localRef.createdAt || "1970");
      const st = Date.parse(serverRef.createdAt || "1970");
      map.set(s.id, st >= lt ? serverRef : localRef);
    }
  }
  return Array.from(map.values());
}

function rowToBet(s: ServerBet): Bet {
  return {
    id: s.id,
    raceId: s.race_id,
    raceName: s.race_name,
    type: s.bet_type || s.type || "複勝",
    horses: s.target || "",
    amount: Number(s.amount) || 0,
    payout: s.result?.payout,
    result: s.result?.won === true ? "hit" : s.result?.won === false ? "miss" : "pending",
    ev: s.ev,
    createdAt: s.ts || s.created_at || new Date().toISOString(),
  };
}

function betToRow(b: Bet, userId: string) {
  const wonFlag =
    b.result === "hit"  ? true  :
    b.result === "miss" ? false : null;
  return {
    id: b.id,
    user_id: userId,
    ts: b.createdAt,
    type: "real",
    amount: b.amount,
    race_name: b.raceName,
    race_id: b.raceId,
    target: b.horses,
    bet_type: b.type,
    ev: b.ev,
    result: wonFlag === null ? null : { won: wonFlag, payout: b.payout ?? 0 },
    profit: (b.payout ?? 0) - b.amount,
    auto_saved: !!b.isDraft,
    data_source: "phase5_v2",
  };
}

function rowToRef(s: ServerRef): StructuredReflection {
  return {
    id: s.id,
    betId: s.bet_id || "",
    raceId: s.race_id,
    raceName: s.race_name,
    course: s.course,
    tags: (s.tags || []) as StructuredReflection["tags"],
    freeText: s.free_text || "",
    weightSuggestion: s.weight_suggestion,
    createdAt: s.created_at || new Date().toISOString(),
  };
}

function refToRow(r: StructuredReflection, userId: string) {
  return {
    id: r.id,
    user_id: userId,
    bet_id: r.betId,
    race_id: r.raceId,
    race_name: r.raceName,
    course: r.course,
    tags: r.tags,
    free_text: r.freeText,
    weight_suggestion: r.weightSuggestion ?? {},
    created_at: r.createdAt,
  };
}
