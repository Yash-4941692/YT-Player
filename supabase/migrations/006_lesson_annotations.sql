-- Focusframe: annotations drawn on a LESSON's own PDF notes now sync across devices too,
-- and both annotation tables are published for live updates between devices.
--
-- Until now only library PDFs synced their drawings. Notes uploaded straight onto a lesson
-- were saved in one browser only, so they never appeared on a second device. This migration
-- adds one new table for those documents — `lesson_annotations`, keyed by the lesson's
-- YouTube video id — with the same private, per-user access as `pdf_annotations`.
--
-- Purely additive: nothing that already exists is altered or dropped, so lessons, progress,
-- timestamps, the PDF library, its annotations and every stored file are untouched. The PDF
-- files themselves keep living in the private `video-notes` bucket under `<user id>/…`.
--
-- New projects only need supabase/schema.sql, which already contains this block.
-- Run once in Supabase SQL Editor -> New query -> Run. Safe to run again.
-- Success message: "Success. No rows returned."

-- `updated_at` is the revision stamp written by the browser that saved the document, the
-- same as in pdf_annotations. Do not replace it with a now() trigger.
create table if not exists public.lesson_annotations (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The YouTube video id whose notes PDF the drawings belong to.
  video_id text not null,
  -- Shape of `data`: { "version": 1, "annotations": [ ... ] }
  data jsonb not null default '{"version":1,"annotations":[]}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, video_id)
);

create index if not exists lesson_annotations_user_updated_idx
  on public.lesson_annotations (user_id, updated_at desc);

alter table public.lesson_annotations enable row level security;
grant select, insert, update, delete on public.lesson_annotations to authenticated;

drop policy if exists "Users read their own lesson annotations" on public.lesson_annotations;
create policy "Users read their own lesson annotations" on public.lesson_annotations
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "Users add their own lesson annotations" on public.lesson_annotations;
create policy "Users add their own lesson annotations" on public.lesson_annotations
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "Users update their own lesson annotations" on public.lesson_annotations;
create policy "Users update their own lesson annotations" on public.lesson_annotations
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users delete their own lesson annotations" on public.lesson_annotations;
create policy "Users delete their own lesson annotations" on public.lesson_annotations
  for delete to authenticated using (auth.uid() = user_id);

-- Optional but recommended: publish both annotation tables so a drawing saved on one device
-- appears on another device that already has the same PDF open, without reloading. Realtime
-- still respects the row level security policies above, so a user only ever receives their
-- own rows. The app works without this — it also re-reads on focus and on reopen.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pdf_annotations'
    ) then
      alter publication supabase_realtime add table public.pdf_annotations;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lesson_annotations'
    ) then
      alter publication supabase_realtime add table public.lesson_annotations;
    end if;
  end if;
exception when others then
  -- Publishing is a bonus, never a requirement: the tables above are already usable and the
  -- app falls back to re-reading annotations when the tab regains focus.
  raise notice 'Focusframe: could not publish annotation tables for realtime (%).', sqlerrm;
end $$;
