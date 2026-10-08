-- Focusframe: annotations drawn on PDF-library PDFs (highlight, pen, shapes, sticky notes).
--
-- This migration is purely additive: it creates one new table (`pdf_annotations`) with its
-- own policies. It changes nothing that already exists, so lessons, progress, timestamps,
-- your PDF library, and every stored file are untouched.
--
-- New projects only need supabase/schema.sql, which already contains this block.
-- Run once in Supabase SQL Editor -> New query -> Run. Safe to run again.
-- Success message: "Success. No rows returned."

-- `updated_at` is the revision stamp written by the browser that saved the document (see
-- `nextRevisionStamp` in src/lib/storage.ts); the app compares it across devices to decide
-- which copy is newer. Do not add a trigger that replaces it with now(): a database clock
-- behind the newest stored revision would move a document's revision backwards.
create table if not exists public.pdf_annotations (
  -- One annotation document per library PDF. Deleting the PDF removes its annotations.
  pdf_id uuid primary key references public.pdf_library(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Shape of `data`: { "version": 1, "annotations": [ ... ] }
  data jsonb not null default '{"version":1,"annotations":[]}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pdf_annotations_user_idx
  on public.pdf_annotations (user_id, updated_at desc);

alter table public.pdf_annotations enable row level security;
grant select, insert, update, delete on public.pdf_annotations to authenticated;

drop policy if exists "Users read their own PDF annotations" on public.pdf_annotations;
create policy "Users read their own PDF annotations" on public.pdf_annotations
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "Users add their own PDF annotations" on public.pdf_annotations;
create policy "Users add their own PDF annotations" on public.pdf_annotations
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "Users update their own PDF annotations" on public.pdf_annotations;
create policy "Users update their own PDF annotations" on public.pdf_annotations
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users delete their own PDF annotations" on public.pdf_annotations;
create policy "Users delete their own PDF annotations" on public.pdf_annotations
  for delete to authenticated using (auth.uid() = user_id);

-- Nothing else to do: the PDF files themselves keep living in the existing private
-- `video-notes` bucket under `<user id>/library/...`.
