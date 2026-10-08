-- Focusframe: repair the lessons table that cross-device sync is built on.
--
-- WHY THIS FILE EXISTS
-- `watch_items` holds every lesson: its progress, its timestamp chapters and the pointer to
-- its PDF notes. It is what a second device reads when you sign in there. In earlier copies
-- of supabase/schema.sql the progress column was written as `current_time` without quotes.
-- PostgreSQL treats CURRENT_TIME as a reserved word, so that single CREATE TABLE statement
-- failed, the table and its policies were never created, and every write of a lesson (or of
-- a PDF attached to a lesson) was rejected by the API — which is exactly how lessons and
-- their PDFs stopped following an account to another device.
--
-- WHAT THIS FILE DOES (all of it safe and repeatable)
--   1. creates `watch_items` with its policies if it is missing, with the progress column
--      correctly quoted,
--   2. adds any column the app writes that an older copy of the table is missing,
--   3. re-asserts row level security so each account only ever sees its own lessons.
--
-- WHAT IT NEVER TOUCHES
-- No row is deleted, no column is dropped, and your PDF library, annotations, "Recently
-- deleted" list, activity records and every file in the `video-notes` bucket are untouched.
-- If an old table kept playhead positions under a different column name, those values stay
-- in place but are no longer read: each lesson simply starts its progress again from where
-- it is watched next.
--
-- New projects do not need this file: supabase/schema.sql already contains the fixed table.
-- Run once in Supabase SQL Editor -> New query -> Run. Safe to run again.
-- Success message: "Success. No rows returned."

-- 1. The lessons table itself, exactly as the app expects it.
create table if not exists public.watch_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  video_id text not null,
  title text not null default 'YouTube study session',
  channel text not null default '',
  thumbnail text not null default '',
  playlist_id text,
  playlist_index integer,
  chapters_raw text not null default '',
  -- CURRENT_TIME is a reserved word in PostgreSQL: the quotes are required.
  "current_time" double precision not null default 0,
  duration double precision not null default 0,
  subject text not null default 'Other' check (subject in ('Physics', 'Chemistry', 'Mathematics', 'Other')),
  hidden_from_recent boolean not null default false,
  pdf_path text,
  pdf_name text,
  pdf_size bigint,
  updated_at timestamptz not null default now(),
  primary key (user_id, video_id)
);

-- 2. Repair a table that exists but predates some columns (for example one created by a much
--    earlier version of the app). Every clause is a no-op when the column is already there.
alter table public.watch_items
  add column if not exists "current_time" double precision not null default 0,
  add column if not exists duration double precision not null default 0,
  add column if not exists chapters_raw text not null default '',
  add column if not exists playlist_id text,
  add column if not exists playlist_index integer,
  add column if not exists hidden_from_recent boolean not null default false,
  add column if not exists pdf_path text,
  add column if not exists pdf_name text,
  add column if not exists pdf_size bigint,
  add column if not exists title text not null default 'YouTube study session',
  add column if not exists channel text not null default '',
  add column if not exists thumbnail text not null default '',
  add column if not exists subject text not null default 'Other',
  add column if not exists updated_at timestamptz not null default now();

-- 3. Private to its owner, exactly like every other table in this project.
alter table public.watch_items enable row level security;
grant select, insert, update, delete on public.watch_items to authenticated;

drop policy if exists "Users read their own watch items" on public.watch_items;
create policy "Users read their own watch items" on public.watch_items
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "Users insert their own watch items" on public.watch_items;
create policy "Users insert their own watch items" on public.watch_items
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "Users update their own watch items" on public.watch_items;
create policy "Users update their own watch items" on public.watch_items
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users delete their own watch items" on public.watch_items;
create policy "Users delete their own watch items" on public.watch_items
  for delete to authenticated using (auth.uid() = user_id);

-- A repaired table has no `is_revision` / `bookmarks` leftovers, which is fine: nothing in
-- the app reads them. If a much older table still has them, they simply sit there unused
-- (see supabase/migrations/004_optional_drop_legacy.sql if you want them gone).
