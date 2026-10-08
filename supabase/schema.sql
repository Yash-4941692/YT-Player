-- Focusframe JEE study player: run this once in Supabase SQL Editor.
-- Legacy columns (kept on purpose for projects created before this version):
-- watch_items.is_revision and watch_items.bookmarks are no longer read or written by the
-- app. The app reads/writes watch_items (lessons, progress, chapters, PDF pointers),
-- pdf_library (the personal, cross-device PDF shelf), pdf_annotations (annotations drawn
-- on library PDFs), lesson_annotations (annotations drawn on a lesson's own PDF notes) and
-- the private video-notes bucket.
-- Existing projects that want those unused columns gone can opt in by running
-- supabase/migrations/004_optional_drop_legacy.sql — that file is never run automatically
-- and is not needed for the app to work.
-- Never put a Supabase service_role key in the browser or in Vercel's VITE_* variables.

create table if not exists public.watch_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  video_id text not null,
  title text not null default 'YouTube study session',
  channel text not null default '',
  thumbnail text not null default '',
  playlist_id text,
  playlist_index integer,
  chapters_raw text not null default '',
  -- PostgreSQL treats CURRENT_TIME as a reserved word, so this column MUST stay quoted:
  -- unquoted it is a syntax error, the whole CREATE TABLE fails and nothing about lessons
  -- (progress, chapters, the PDF pointer) can sync. Quoted, the column name is still the
  -- plain lowercase `current_time` that the app reads and writes.
  "current_time" double precision not null default 0,
  duration double precision not null default 0,
  subject text not null default 'Other' check (subject in ('Physics', 'Chemistry', 'Mathematics', 'Other')),
  is_revision boolean not null default false,
  hidden_from_recent boolean not null default false,
  bookmarks jsonb not null default '[]'::jsonb,
  pdf_path text,
  pdf_name text,
  pdf_size bigint,
  updated_at timestamptz not null default now(),
  primary key (user_id, video_id)
);

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

-- The whole study_state table (and the is_revision / bookmarks columns above) is unused by
-- the app. New projects do not create it at all; older projects can drop it with the
-- optional migration supabase/migrations/004_optional_drop_legacy.sql.
-- PDF library: PDFs that belong to the account rather than to one lesson.
-- Files are stored in the same private `video-notes` bucket under `<user id>/library/`.
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

-- Annotations drawn on library PDFs (highlight, pen, shapes, sticky notes).
-- One row per PDF; the drawing data lives in the `data` jsonb column.
create table if not exists public.pdf_annotations (
  pdf_id uuid primary key references public.pdf_library(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
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

-- Annotations drawn on a lesson's OWN PDF notes (uploaded straight onto the lesson rather
-- than into the library): one row per user + video id, same shape of `data` as above.
create table if not exists public.lesson_annotations (
  user_id uuid not null references auth.users(id) on delete cascade,
  video_id text not null,
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

-- Live updates between devices: both annotation tables are published for realtime, which
-- still respects the row level security policies above. Purely optional — the app also
-- re-reads annotations when the tab regains focus and whenever a PDF is reopened.
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

-- "Recently deleted" PDFs. The pdf_library row and the stored file are kept; a row here
-- just means "hidden from the library until restored or deleted forever".
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

-- Per-PDF activity: last opened time and page count. Informational only.
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

-- Private bucket for per-video notes. The app enforces a 100 MB client-side cap;
-- Supabase's project/plan upload limits may be lower and can reject larger files.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('video-notes', 'video-notes', false, 104857600, array['application/pdf'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users read their own video notes" on storage.objects;
create policy "Users read their own video notes" on storage.objects
  for select to authenticated using (
    bucket_id = 'video-notes' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users upload their own video notes" on storage.objects;
create policy "Users upload their own video notes" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'video-notes' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users update their own video notes" on storage.objects;
create policy "Users update their own video notes" on storage.objects
  for update to authenticated using (
    bucket_id = 'video-notes' and (storage.foldername(name))[1] = auth.uid()::text
  ) with check (
    bucket_id = 'video-notes' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users delete their own video notes" on storage.objects;
create policy "Users delete their own video notes" on storage.objects
  for delete to authenticated using (
    bucket_id = 'video-notes' and (storage.foldername(name))[1] = auth.uid()::text
  );
