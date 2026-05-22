"use client";

import type { StructuredReflection, MissTag } from "@/lib/reflection";

const KEY = "keiba.reflections.v1";

export function loadReflections(): StructuredReflection[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr as StructuredReflection[];
  } catch {
    return [];
  }
}

export function saveReflection(r: StructuredReflection) {
  if (typeof window === "undefined") return;
  const arr = loadReflections();
  const idx = arr.findIndex((x) => x.id === r.id);
  if (idx >= 0) arr[idx] = r;
  else arr.push(r);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(arr));
    window.dispatchEvent(new CustomEvent("keiba:reflection-added"));
  } catch {
    /* ignore */
  }
}

export function deleteReflection(id: string) {
  if (typeof window === "undefined") return;
  const arr = loadReflections().filter((x) => x.id !== id);
  window.localStorage.setItem(KEY, JSON.stringify(arr));
  window.dispatchEvent(new CustomEvent("keiba:reflection-added"));
}

/** タグ別の発生回数 (頻度ダッシュボード用) */
export function tagFrequency(reflections: StructuredReflection[] = loadReflections()): Array<{ tag: MissTag; count: number }> {
  const map = new Map<MissTag, number>();
  for (const r of reflections) {
    for (const t of r.tags) {
      map.set(t, (map.get(t) || 0) + 1);
    }
  }
  return Array.from(map.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

/** 直近 N 件 */
export function recentReflections(n = 5): StructuredReflection[] {
  return loadReflections()
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, n);
}
