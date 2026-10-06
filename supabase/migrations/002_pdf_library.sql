-- Focusframe: adds the PDF library for projects that already ran supabase/schema.sql.
--
-- This migration is purely additive. It creates a new table and its policies and touches
-- nothing else, so existing lessons, progress, timestamps and lesson PDFs are untouched.
-- New projects only need supabase/schema.sql, which already contains this block.
--
-- Run once in Supabase SQL Editor → New query → Run. Safe to run again.

create table if not exists public.pdf_library (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'notes.pdf',
  subject text not null default 'Other' check (subject in ('Physics', 'Chemistry', 'Mathematics', 'Other')),
  size bigint not null default 0,
  storage_path text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pdf_library_user_updated_idx
  on public.pdf_library (user_id, updated_at desc);

alter table public.pdf_library enable row level security;
grant select, insert, update, delete on public.pdf_library to authenticated;

drop policy if exists "Users read their own library PDFs" on public.pdf_library;
create policy "Users read their own library PDFs" on public.pdf_library
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "Users add their own library PDFs" on public.pdf_library;
create policy "Users add their own library PDFs" on public.pdf_library
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "Users update their own library PDFs" on public.pdf_library;
create policy "Users update their own library PDFs" on public.pdf_library
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users delete their own library PDFs" on public.pdf_library;
create policy "Users delete their own library PDFs" on public.pdf_library
  for delete to authenticated using (auth.uid() = user_id);

-- No new bucket is needed: library files are written to the existing private
-- `video-notes` bucket under `<user id>/library/…`, which the bucket's existing
-- policies already restrict to the signed-in user.
