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
-- 6. 集計テーブル (JV-Link で取得した過去レースから集計した特徴量)
--    用途:
--      jv_bridge/aggregate_features.py が過去レース (RA + SE + HR) を
--      横断集計して各テーブルへ UPSERT する。
--      predictors/jv_link_features.js が data/jv_cache/features.json から
--      読むが、将来は Supabase REST で取りに行く構成にも切替可能。
--
--    重要な設計判断:
--      ・ユーザー固有データではないので user_id を持たない (グローバル参照)
--      ・誰でも読めるが、書き込みは service_role キーだけ
--        (集計バッチが自分のPCで動き、service_role で push する想定)
--      ・JRA-VAN 規約上「再配布」に当たらないよう、生レコードではなく
--        集計結果のみ保存 (勝率・本数のような数値のみ)
-- ============================================================

-- 6-1. 騎手別 × (コース,距離,芝ダ) 集計
create table if not exists keiba.jockey_stats (
  jockey_name  text not null,
  course_code  text,                       -- 場コード 01-10 (null = 全場合算)
  distance     integer,                    -- 距離(m), null = 全距離合算
  surface      text,                       -- '芝'|'ダ'|'障'|null=全種類
  samples      integer not null default 0,
  wins         integer not null default 0,
  win_rate     numeric generated always as (case when samples > 0 then wins::numeric / samples else 0 end) stored,
  updated_at   timestamptz default now(),
  primary key (jockey_name, course_code, distance, surface)
);
create index if not exists jockey_stats_name_idx on keiba.jockey_stats(jockey_name);

-- 6-2. 調教師別 × (コース,距離,芝ダ) 集計
create table if not exists keiba.trainer_stats (
  trainer_name text not null,
  course_code  text,
  distance     integer,
  surface      text,
  samples      integer not null default 0,
  wins         integer not null default 0,
  win_rate     numeric generated always as (case when samples > 0 then wins::numeric / samples else 0 end) stored,
  updated_at   timestamptz default now(),
  primary key (trainer_name, course_code, distance, surface)
);
create index if not exists trainer_stats_name_idx on keiba.trainer_stats(trainer_name);

-- 6-3. 馬個別キャリア (出走歴・勝利数・前走情報)
create table if not exists keiba.horse_career (
  horse_name      text primary key,
  total_starts    integer not null default 0,
  total_wins      integer not null default 0,
  total_in_three  integer not null default 0,  -- 3着以内
  last_race_at    date,
  best_time_sec   numeric,                     -- 持ち時計 (最速タイム)
  avg_last_3f     numeric,                     -- 上がり3F 平均
  updated_at      timestamptz default now()
);

-- 6-4. コース×距離別 全体傾向 (馬場バイアス把握用)
create table if not exists keiba.course_distance_stats (
  course_code text not null,
  distance    integer not null,
  surface     text not null,                   -- '芝'|'ダ'|'障'
  samples     integer not null default 0,
  avg_winning_time_sec  numeric,
  avg_last_3f           numeric,
  inside_advantage_pct  numeric,               -- 内枠1-4の勝率
  updated_at  timestamptz default now(),
  primary key (course_code, distance, surface)
);

-- 6-5. 集計バッチの最終実行ログ (UI で「最終更新: ◯月◯日」を出す用)
create table if not exists keiba.aggregate_meta (
  key          text primary key,               -- 'jockey_stats'|'trainer_stats'|'horse_career'|'course_distance_stats'
  last_run_at  timestamptz,
  source_from  date,                           -- 集計対象の起点日
  source_to    date,                           -- 集計対象の終端日
  row_count    integer
);

-- 6-7. レース結果 (HR 由来・払戻と着順) を Supabase に保存
--    用途:
--      手元 PC で取得した結果データを Supabase へ UPSERT すると、
--      本番 Vercel の API からも結果照合 (finalize) できるようになる。
--      これにより「リアル馬券の○×を外出先のスマホから確認」が可能に。
create table if not exists keiba.race_results (
  race_id      text primary key,                       -- 18 桁 JRA レース ID
  race_name    text,
  finished_at  timestamptz,
  results      jsonb not null default '[]'::jsonb,     -- [{rank, number, name, tan_payout}]
  payouts      jsonb not null default '{}'::jsonb,     -- {tan, fuku, uren, wide, fuku3, tan3}
  source       text default 'jv_link',
  updated_at   timestamptz default now()
);
create index if not exists race_results_finished_idx on keiba.race_results(finished_at desc);

alter table keiba.race_results enable row level security;
drop policy if exists "race_results: read" on keiba.race_results;
create policy "race_results: read" on keiba.race_results for select using (auth.role() = 'authenticated');

drop trigger if exists race_results_updated_at on keiba.race_results;
create trigger race_results_updated_at before update on keiba.race_results
  for each row execute function keiba.set_updated_at();

-- 6-6. RLS: 認証ユーザーは読み取り可、書き込みは service_role のみ
alter table keiba.jockey_stats          enable row level security;
alter table keiba.trainer_stats         enable row level security;
alter table keiba.horse_career          enable row level security;
alter table keiba.course_distance_stats enable row level security;
alter table keiba.aggregate_meta        enable row level security;

drop policy if exists "jockey_stats: read"     on keiba.jockey_stats;
drop policy if exists "trainer_stats: read"    on keiba.trainer_stats;
drop policy if exists "horse_career: read"     on keiba.horse_career;
drop policy if exists "course_stats: read"     on keiba.course_distance_stats;
drop policy if exists "aggregate_meta: read"   on keiba.aggregate_meta;

create policy "jockey_stats: read"   on keiba.jockey_stats          for select using (auth.role() = 'authenticated');
create policy "trainer_stats: read"  on keiba.trainer_stats         for select using (auth.role() = 'authenticated');
create policy "horse_career: read"   on keiba.horse_career          for select using (auth.role() = 'authenticated');
create policy "course_stats: read"   on keiba.course_distance_stats for select using (auth.role() = 'authenticated');
create policy "aggregate_meta: read" on keiba.aggregate_meta        for select using (auth.role() = 'authenticated');

-- 書き込みは service_role キー (集計バッチ専用) のみ許可。
-- service_role は RLS をバイパスするため明示的なポリシー不要。

drop trigger if exists jockey_stats_updated_at  on keiba.jockey_stats;
drop trigger if exists trainer_stats_updated_at on keiba.trainer_stats;
drop trigger if exists horse_career_updated_at  on keiba.horse_career;
drop trigger if exists course_stats_updated_at  on keiba.course_distance_stats;
create trigger jockey_stats_updated_at  before update on keiba.jockey_stats          for each row execute function keiba.set_updated_at();
create trigger trainer_stats_updated_at before update on keiba.trainer_stats         for each row execute function keiba.set_updated_at();
create trigger horse_career_updated_at  before update on keiba.horse_career          for each row execute function keiba.set_updated_at();
create trigger course_stats_updated_at  before update on keiba.course_distance_stats for each row execute function keiba.set_updated_at();

-- ============================================================
-- 注意: 完了後、Supabase Dashboard → Settings → API → "Exposed schemas" に
--       'keiba' を追加すること (PostgREST が外部に公開するため)。
--       公開しないとクライアントから `from('bets')` 等で見えない。
-- ============================================================
