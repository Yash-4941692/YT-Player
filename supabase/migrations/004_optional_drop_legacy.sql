-- ============================================================================
-- OPTIONAL cleanup — 004_optional_drop_legacy.sql
-- ============================================================================
--
-- YOU DO NOT NEED TO RUN THIS FILE. The app works perfectly with or without it.
--
-- What it does: removes database leftovers from very early versions of Focusframe
-- that nothing reads or writes any more:
--
--   1. the whole `study_state` table (an old, superseded way of storing state),
--   2. `watch_items.is_revision` (the "mark as revision" flag was never used),
--   3. `watch_items.bookmarks` (bookmarks were never built).
--
-- What it never touches: your lessons, watch progress, timestamps, PDF pointers,
-- your PDF library, your annotations, or any file in the `video-notes` bucket.
-- No row of real data is deleted by this file.
--
-- WHY IT IS OPTIONAL AND MANUAL:
--   * It is destructive by nature (DROP COLUMN / DROP TABLE), so the site owner
--     must choose to run it. It is never executed automatically by the app,
--     by a Vercel deploy, or by supabase/schema.sql.
--   * If you are not sure, simply skip it. Leaving the unused table and columns
--     in place costs almost nothing (an empty table and two defaulted columns).
--
-- HOW TO RUN IT (only if you want the cleanup):
--   1. Supabase Dashboard -> SQL Editor -> New query.
--   2. Paste this whole file and press Run.
--   Success message: "Success. No rows returned."
--   (If the table/columns were already gone, you get the same message — the file
--   is written to be safe to run twice.)
--
-- HOW TO UNDO: you cannot get the dropped columns back with data (they only ever
-- held defaults), but nothing else is affected. Re-running supabase/schema.sql
-- does NOT recreate them for existing tables, which is intentional.
-- ============================================================================

-- 1. The unused study_state table (its policies go with it).
drop table if exists public.study_state cascade;

-- 2. The two unused watch_items columns. Written defensively so this file is
--    repeatable and works even if one of the columns was never created.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'watch_items' and column_name = 'is_revision'
  ) then
    alter table public.watch_items drop column is_revision;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'watch_items' and column_name = 'bookmarks'
  ) then
    alter table public.watch_items drop column bookmarks;
  end if;
end $$;
