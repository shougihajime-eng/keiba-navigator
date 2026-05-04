-- KEIBA NAVIGATOR — Supabase スキーマ
-- 実行方法: Supabase Dashboard → SQL Editor → 全文を貼り付け → Run
-- 既存テーブルがあっても安全 (IF NOT EXISTS / CREATE OR REPLACE)

-- ============================================================
-- 1. ユーザー設定 (1ユーザー1行)
-- ============================================================
create table if not exists public.user_settings (
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
create table if not exists public.bets (
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

create index if not exists bets_user_ts_idx on public.bets(user_id, ts desc);
create index if not exists bets_user_race_idx on public.bets(user_id, race_id);

-- ============================================================
-- 3. Row Level Security: 自分のデータしか読み書きできない
-- ============================================================
alter table public.user_settings enable row level security;
alter table public.bets enable row level security;

drop policy if exists "settings: owner can read"    on public.user_settings;
drop policy if exists "settings: owner can write"   on public.user_settings;
drop policy if exists "bets: owner can read"        on public.bets;
drop policy if exists "bets: owner can write"       on public.bets;

create policy "settings: owner can read"  on public.user_settings for select using (auth.uid() = user_id);
create policy "settings: owner can write" on public.user_settings for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "bets: owner can read"  on public.bets for select using (auth.uid() = user_id);
create policy "bets: owner can write" on public.bets for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- 4. updated_at 自動更新トリガ
-- ============================================================
create or replace function public.set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists user_settings_updated_at on public.user_settings;
create trigger user_settings_updated_at before update on public.user_settings
  for each row execute function public.set_updated_at();
