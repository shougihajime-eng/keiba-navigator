-- KEIBA NAVIGATOR — Supabase スキーマ (keiba 名前空間)
-- 実行方法:
--   方法A) Supabase Dashboard → SQL Editor → 全文を貼り付け → Run
--   方法B) npx supabase db execute --file db/schema.sql --project-ref eqkaaohdbqefuszxwqzr
--
-- 共有 Supabase (~/.claude/CLAUDE.md 参照) を使うため、本プロジェクトのテーブルは
-- すべて keiba スキーマに置く。public スキーマは使わない (他プロジェクトと干渉しない)。
--
-- 既存テーブルがあっても安全 (IF NOT EXISTS / CREATE OR REPLACE)

-- ============================================================
-- 0. 専用スキーマ
-- ============================================================
create schema if not exists keiba;
grant usage on schema keiba to anon, authenticated;
alter default privileges in schema keiba grant select, insert, update, delete on tables to authenticated;

-- ============================================================
-- 1. ユーザー設定 (1ユーザー1行)
-- ============================================================
create table if not exists keiba.user_settings (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  funds      jsonb,                 -- { daily, perRace, minEv }
  strategy   text default 'balance',
  risk       text default 'tight',
  version    integer default 1,
  updated_at timestamptz default now()
);

-- ============================================================
-- 2. 馬券記録 (ユーザー × 多数行)
-- ============================================================
create table if not exists keiba.bets (
  id          text primary key,                -- クライアントが採番 (auto_xxx / b_xxx)
  user_id     uuid not null references auth.users(id) on delete cascade,
  ts          timestamptz not null,
  type        text not null check (type in ('air','real')),
  amount      integer not null check (amount >= 0),
  race_name   text,
  race_id     text,
  target      text,
  bet_type    text default 'tan',              -- tan|fuku|uren|wide|fuku3|tan3|tan_san
  odds        numeric,
  prob        numeric,
  ev          numeric,
  grade       text,                            -- S|A|B|C|D
  data_source text not null default 'unknown', -- jv_link|dummy|unknown
  result      jsonb,                           -- {won, payout, finishedAt}
  factors     text[],                          -- 自動勝因/敗因 タグ
  profit      integer,
  auto_saved  boolean default false,
  created_at  timestamptz default now()
);

create index if not exists bets_user_ts_idx on keiba.bets(user_id, ts desc);
create index if not exists bets_user_race_idx on keiba.bets(user_id, race_id);

-- ============================================================
-- 3. 学習モデルの状態 (重み・ハイパー・累計指標)
--    - 1ユーザー1行
--    - クライアント側 online learner が更新する
--    - サーバ側で学習する場合もこのテーブルを更新
-- ============================================================
create table if not exists keiba.learner_state (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  model_name  text not null default 'heuristic_v1',
  weights     jsonb not null default '{}'::jsonb,        -- { prevFinish: 0.4, jockey: 2.0, ... }
  metrics     jsonb not null default '{}'::jsonb,        -- { samples, hits, misses, recovery, brier }
  history     jsonb not null default '[]'::jsonb,        -- 直近 N 件の学習ログ
  level       integer not null default 1,                -- AI 育成レベル (1-5)
  updated_at  timestamptz default now()
);

-- ============================================================
-- 4. Row Level Security: 自分のデータしか読み書きできない
-- ============================================================
alter table keiba.user_settings enable row level security;
alter table keiba.bets          enable row level security;
alter table keiba.learner_state enable row level security;

drop policy if exists "settings: owner can read"  on keiba.user_settings;
drop policy if exists "settings: owner can write" on keiba.user_settings;
drop policy if exists "bets: owner can read"      on keiba.bets;
drop policy if exists "bets: owner can write"     on keiba.bets;
drop policy if exists "learner: owner can read"   on keiba.learner_state;
drop policy if exists "learner: owner can write"  on keiba.learner_state;

create policy "settings: owner can read"  on keiba.user_settings for select using (auth.uid() = user_id);
create policy "settings: owner can write" on keiba.user_settings for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "bets: owner can read"      on keiba.bets          for select using (auth.uid() = user_id);
create policy "bets: owner can write"     on keiba.bets          for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "learner: owner can read"   on keiba.learner_state for select using (auth.uid() = user_id);
create policy "learner: owner can write"  on keiba.learner_state for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- 5. updated_at 自動更新トリガ
-- ============================================================
create or replace function keiba.set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists user_settings_updated_at on keiba.user_settings;
create trigger user_settings_updated_at before update on keiba.user_settings
  for each row execute function keiba.set_updated_at();

drop trigger if exists learner_state_updated_at on keiba.learner_state;
create trigger learner_state_updated_at before update on keiba.learner_state
  for each row execute function keiba.set_updated_at();

-- ============================================================
-- 注意: 完了後、Supabase Dashboard → Settings → API → "Exposed schemas" に
--       'keiba' を追加すること (PostgREST が外部に公開するため)。
--       公開しないとクライアントから `from('bets')` 等で見えない。
-- ============================================================
