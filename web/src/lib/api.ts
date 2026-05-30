// API クライアント — 既存 Vercel Functions を直接叩く
// 環境変数 NEXT_PUBLIC_API_BASE で接続先を変更可能
//   - dev:  http://127.0.0.1:8765
//   - prod: https://keiba-navigator.vercel.app

import type {
  RacesResponse,
  RecommendationsResponse,
  StatusResponse,
  ExperimentStatusResponse,
} from "@/types/api";

function getApiBase(): string {
  const env = process.env.NEXT_PUBLIC_API_BASE;
  if (env) return env.replace(/\/$/, "");
  if (typeof window !== "undefined") {
    // 同一オリジン (Vercel 同居デプロイ) を想定
    return `${window.location.origin}`;
  }
  return "https://keiba-navigator.vercel.app";
}

async function safeFetch<T>(path: string, init?: RequestInit): Promise<T | null> {
  const base = getApiBase();
  const url = `${base}${path}`;
  try {
    const res = await fetch(url, {
      ...init,
      cache: "no-store",
      headers: { "Accept": "application/json", ...(init?.headers || {}) },
    });
    if (!res.ok && res.status !== 503) return null;
    const data = (await res.json()) as T;
    return data;
  } catch (err) {
    console.warn(`[api] fetch failed: ${url}`, err);
    return null;
  }
}

export async function fetchRaces(): Promise<RacesResponse | null> {
  return safeFetch<RacesResponse>("/api/races");
}

export async function fetchRecommendations(): Promise<RecommendationsResponse | null> {
  return safeFetch<RecommendationsResponse>("/api/recommendations");
}

export async function fetchRaceCard() {
  return safeFetch<{ ok: boolean; [key: string]: unknown }>("/api/race-card");
}

export async function fetchRankings() {
  return safeFetch<{ ok: boolean; [key: string]: unknown }>("/api/rankings");
}

export async function fetchStatus(): Promise<StatusResponse | null> {
  return safeFetch<StatusResponse>("/api/status");
}

export async function fetchRace(raceId: string) {
  if (!raceId) return null;
  return safeFetch<{ ok: boolean; race?: unknown }>(`/api/race?id=${encodeURIComponent(raceId)}`);
}

export async function fetchWin5() {
  return safeFetch<{ ok: boolean; [key: string]: unknown }>("/api/win5");
}

export async function fetchNews() {
  return safeFetch<{ ok: boolean; items?: unknown[] }>("/api/news");
}

export async function fetchMlStatus() {
  return safeFetch<{ ok: boolean; [key: string]: unknown }>("/api/ml-status");
}

export async function fetchAutomationStatus() {
  return safeFetch<{ ok: boolean; [key: string]: unknown }>("/api/automation-status");
}

export async function fetchExperimentStatus() {
  return safeFetch<ExperimentStatusResponse>("/api/experiment-status");
}
