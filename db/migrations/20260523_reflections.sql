-- KEIBA NAVIGATOR — Phase 5.2: 構造化反省文テーブル
-- 実行: Supabase Dashboard → SQL Editor、または下記の Management API 経由
--
-- このテーブルは新アプリ (keiba-navigator-v2) の Phase 4 反省ダッシュボードを
-- 端末間で同期するためのもの。localStorage と二重保存し、ログイン時は server-side が source of truth。

create schema if not exists keiba;

-- 構造化反省文 (1 ベットに対して 1 行)
create table if not exists keiba.reflections (
  id            text primary key,                            -- refl_<betId>_<ts>
  user_id       uuid not null references auth.users(id) on delete cascade,
  bet_id        text,                                        -- keiba.bets.id への参照 (cross-refだが FK は付けない)
  race_id       text,
  race_name     text,
  course        text,
  tags          text[] not null default '{}',                -- ['track_condition', 'pace_misread', ...]
  free_text     text,
  weight_suggestion jsonb,                                   -- { track_condition_weight: '+0.03', ... }
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create index if not exists reflections_user_idx on keiba.reflections(user_id, created_at desc);
create index if not exists reflections_user_tags_idx on keiba.reflections using gin (tags);
create index if not exists reflections_race_idx on keiba.reflections(race_id);

alter table keiba.reflections enable row level security;

drop policy if exists "reflections: owner can read"  on keiba.reflections;
drop policy if exists "reflections: owner can write" on keiba.reflections;

create policy "reflections: owner can read"  on keiba.reflections for select using (auth.uid() = user_id);
create policy "reflections: owner can write" on keiba.reflections for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop trigger if exists reflections_updated_at on keiba.reflections;
create trigger reflections_updated_at before update on keiba.reflections
  for each row execute function keiba.set_updated_at();
