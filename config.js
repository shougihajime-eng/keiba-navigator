// KEIBA NAVIGATOR — ランタイム設定
//
// 使い方:
//   1. Supabase Dashboard → Settings → API で URL と anon key をコピー
//   2. 以下の SUPABASE_URL と SUPABASE_ANON_KEY を書き換え
//   3. db/schema.sql を Supabase SQL Editor で実行
//
// 未設定 (デフォルト値のまま) の場合は localStorage で動作します。
// SUPABASE_URL と SUPABASE_ANON_KEY は公開されても安全 (Row Level Security 適用済)。

window.KEIBA_CONFIG = {
  // Supabase クラウド同期 (任意)
  // 例: "https://xxxxxxxxxxxx.supabase.co"
  SUPABASE_URL:      "",
  // 例: "eyJhbGc..."  (anon public key)
  SUPABASE_ANON_KEY: "",
};
