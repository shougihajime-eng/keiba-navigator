// KEIBA NAVIGATOR — ランタイム設定
//
// 共有 Supabase (~/.claude/CLAUDE.md 参照) を keiba スキーマで利用。
// anon key は RLS により保護されるため、git にコミットしても安全。
//
// db スキーマ: keiba (他プロジェクトと完全分離)
// テーブル:    keiba.user_settings / keiba.bets / keiba.learner_state
// 認証:        Supabase Auth Magic Link (メールのみ)

window.KEIBA_CONFIG = {
  SUPABASE_URL:      "https://eqkaaohdbqefuszxwqzr.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVxa2Fhb2hkYnFlZnVzenh3cXpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0NDg4NjcsImV4cCI6MjA5MzAyNDg2N30.91ypwWiV3jLKh0OL2NOQsRBXf3PfFAiR1kHbHlxYLA8",
  SUPABASE_SCHEMA:   "keiba",
};
