-- Focusframe: "Recently deleted" PDFs and per-PDF activity (last opened + page count).
--
-- Purely additive: two new tables with their own policies. Nothing that already exists is
-- altered or dropped, so your PDF library, annotations, files, lessons and progress are
-- untouched. The PDFs themselves stay in the existing private `video-notes` bucket: moving
-- a PDF to "Recently deleted" only records a note here, and a restore simply removes it.
--
-- New projects only need supabase/schema.sql, which already contains this block.
-- Run once in Supabase SQL Editor -> New query -> Run. Safe to run again.
-- Success message: "Success. No rows returned."

-- 1. Recently deleted PDFs. The pdf_library row and the stored file are kept as they are;
--    a row here just means "hidden from the library until restored or deleted forever".
create table if not exists public.pdf_trash (
  pdf_id uuid primary key references public.pdf_library(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  deleted_at timestamptz not null default now()
);

create index if not exists pdf_trash_user_idx
  on public.pdf_trash (user_id, deleted_at desc);

alter table public.pdf_trash enable row level security;
grant select, insert, update, delete on public.pdf_trash to authenticated;

drop policy if exists "Users read their own deleted PDFs" on public.pdf_trash;
create policy "Users read their own deleted PDFs" on public.pdf_trash
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "Users add their own deleted PDFs" on public.pdf_trash;
create policy "Users add their own deleted PDFs" on public.pdf_trash
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "Users update their own deleted PDFs" on public.pdf_trash;
create policy "Users update their own deleted PDFs" on public.pdf_trash
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users delete their own deleted PDFs" on public.pdf_trash;
create policy "Users delete their own deleted PDFs" on public.pdf_trash
  for delete to authenticated using (auth.uid() = user_id);

-- 2. Per-PDF activity: when it was last opened and how many pages it has. Purely
--    informational — the library works fine if these values are missing.
create table if not exists public.pdf_activity (
  pdf_id uuid primary key references public.pdf_library(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_opened_at timestamptz,
  page_count integer,
  updated_at timestamptz not null default now()
);

create index if not exists pdf_activity_user_opened_idx
  on public.pdf_activity (user_id, last_opened_at desc);

alter table public.pdf_activity enable row level security;
grant select, insert, update, delete on public.pdf_activity to authenticated;

drop policy if exists "Users read their own PDF activity" on public.pdf_activity;
create policy "Users read their own PDF activity" on public.pdf_activity
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "Users add their own PDF activity" on public.pdf_activity;
create policy "Users add their own PDF activity" on public.pdf_activity
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "Users update their own PDF activity" on public.pdf_activity;
create policy "Users update their own PDF activity" on public.pdf_activity
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users delete their own PDF activity" on public.pdf_activity;
create policy "Users delete their own PDF activity" on public.pdf_activity
  for delete to authenticated using (auth.uid() = user_id);
