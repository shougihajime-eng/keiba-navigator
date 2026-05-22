// 暫定予想のスナップショット管理
// 朝に取得した予想を localStorage に保存し、10分前の最終確定との差分を取る
"use client";

import type { RaceSummary } from "@/types/api";
import type { Rating } from "@/lib/rating";

const KEY_PREFIX = "keiba.snapshot.v1.";

type Snapshot = {
  raceId: string;
  topNumber: number | null;
  topName: string | null;
  topEv: number | null;
  topOdds: number | null;
  rating: Rating;
  capturedAt: string;
};

export function saveSnapshot(race: RaceSummary, rating: Rating) {
  if (!race.raceId) return;
  const key = KEY_PREFIX + race.raceId;
  const existing = readSnapshot(race.raceId);
  if (existing) return; // 上書きしない (最初の暫定を保持)
  const snap: Snapshot = {
    raceId: race.raceId,
    topNumber: race.topPick?.number ?? null,
    topName: race.topPick?.name ?? null,
    topEv: race.topPick?.ev ?? null,
    topOdds: race.topPick?.odds ?? null,
    rating,
    capturedAt: new Date().toISOString(),
  };
  try {
    window.localStorage.setItem(key, JSON.stringify(snap));
  } catch {
    /* ignore */
  }
}

export function readSnapshot(raceId: string): Snapshot | null {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + raceId);
    if (!raw) return null;
    return JSON.parse(raw) as Snapshot;
  } catch {
    return null;
  }
}

export type Diff = {
  changed: boolean;
  pickChanged: boolean;
  ratingChanged: boolean;
  evChanged: boolean;
  oldRating: Rating | null;
  newRating: Rating;
  oldNumber: number | null;
  newNumber: number | null;
  oldName: string | null;
  newName: string | null;
  oldEv: number | null;
  newEv: number | null;
  message: string;
};

export function compareWithSnapshot(race: RaceSummary, currentRating: Rating): Diff {
  const snap = race.raceId ? readSnapshot(race.raceId) : null;
  if (!snap) {
    return {
      changed: false,
      pickChanged: false,
      ratingChanged: false,
      evChanged: false,
      oldRating: null,
      newRating: currentRating,
      oldNumber: null,
      newNumber: race.topPick?.number ?? null,
      oldName: null,
      newName: race.topPick?.name ?? null,
      oldEv: null,
      newEv: race.topPick?.ev ?? null,
      message: "",
    };
  }
  const newNumber = race.topPick?.number ?? null;
  const newName = race.topPick?.name ?? null;
  const newEv = race.topPick?.ev ?? null;

  const pickChanged = snap.topNumber !== null && newNumber !== null && snap.topNumber !== newNumber;
  const ratingChanged = snap.rating !== currentRating;
  const evChanged =
    snap.topEv !== null && newEv !== null && Math.abs(snap.topEv - newEv) >= 0.05;

  const messages: string[] = [];
  if (ratingChanged) {
    const oldStars = "★".repeat(snap.rating) + "☆".repeat(5 - snap.rating);
    const newStars = "★".repeat(currentRating) + "☆".repeat(5 - currentRating);
    if (snap.rating > currentRating) {
      messages.push(`${oldStars} → ${newStars} に降格。${descendReason(currentRating)}`);
    } else {
      messages.push(`${oldStars} → ${newStars} に昇格。妙味アップ`);
    }
  }
  if (pickChanged) {
    messages.push(
      `買い目変更: ${snap.topNumber}番 ${snap.topName || ""} → ${newNumber}番 ${newName || ""}`,
    );
  }
  if (evChanged && !ratingChanged) {
    const delta = (newEv! - snap.topEv!).toFixed(2);
    const sign = newEv! >= snap.topEv! ? "+" : "";
    messages.push(`期待値 ${snap.topEv?.toFixed(2)} → ${newEv?.toFixed(2)} (${sign}${delta})`);
  }

  return {
    changed: pickChanged || ratingChanged || evChanged,
    pickChanged,
    ratingChanged,
    evChanged,
    oldRating: snap.rating,
    newRating: currentRating,
    oldNumber: snap.topNumber,
    newNumber,
    oldName: snap.topName,
    newName,
    oldEv: snap.topEv,
    newEv,
    message: messages.join(" · "),
  };
}

function descendReason(rating: Rating): string {
  if (rating <= 1) return "妙味消失。見送り推奨";
  if (rating <= 2) return "人気被りで期待値低下";
  return "推奨ランクダウン";
}

/** 古い snapshot をクリーンアップ (7 日以上前) */
export function pruneOldSnapshots() {
  try {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const removeKeys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (!k || !k.startsWith(KEY_PREFIX)) continue;
      try {
        const v = JSON.parse(window.localStorage.getItem(k) || "null") as Snapshot | null;
        if (!v?.capturedAt) continue;
        if (Date.parse(v.capturedAt) < cutoff) removeKeys.push(k);
      } catch {
        /* ignore */
      }
    }
    removeKeys.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}
