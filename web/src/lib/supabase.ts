"use client";

import { createBrowserClient } from "@supabase/ssr";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://eqkaaohdbqefuszxwqzr.supabase.co";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVxa2Fhb2hkYnFlZnVzenh3cXpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0NDg4NjcsImV4cCI6MjA5MzAyNDg2N30.91ypwWiV3jLKh0OL2NOQsRBXf3PfFAiR1kHbHlxYLA8";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSupabase(): any {
  if (typeof window === "undefined") {
    throw new Error("getSupabase() can only be called in the browser");
  }
  if (!client) {
    client = createBrowserClient(URL, ANON, {
      db: { schema: "keiba" },
      auth: {
        persistSession: true,
        storage: window.localStorage,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }
  return client;
}

/** 現在のユーザーセッション (未ログインなら null) */
export async function currentUser() {
  if (typeof window === "undefined") return null;
  try {
    const sb = getSupabase();
    const { data } = await sb.auth.getUser();
    return data.user ?? null;
  } catch {
    return null;
  }
}

export async function signInWithEmail(email: string) {
  const sb = getSupabase();
  return sb.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: typeof window !== "undefined" ? window.location.origin : undefined,
      shouldCreateUser: true,
    },
  });
}

export async function signOut() {
  const sb = getSupabase();
  return sb.auth.signOut();
}
