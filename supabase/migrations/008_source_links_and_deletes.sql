-- Focusframe: direct video links + deletions that really reach every device.
--
-- WHY THIS FILE EXISTS
-- 1. DELETIONS. "Delete forever" used to remove the lesson's row outright. Every other device
--    still had its own cached copy of that lesson, and a row that has simply disappeared
--    cannot tell that copy anything — so on its next sync the device merged the lesson back
--    into the account and it reappeared everywhere. The row now keeps a `deleted_at` stamp
--    (a tombstone) instead: every device reads it, hides the lesson, and stops uploading its
--    own copy. Opening the lesson again clears the stamp, which is the only thing that
--    brings a lesson back.
-- 2. DIRECT VIDEO LINKS. Lessons can now be any direct video link (`.mp4`, an HLS playlist,
--    a file-host download link such as https://filesto.o2zone.space/d/TnYng8W), not only a
--    YouTube id. `source_kind` says which kind it is and `source_url` keeps the link, so the
--    lesson still plays on a second device.
--
-- WHAT THIS FILE DOES (safe to run more than once)
--   • adds `deleted_at`, `source_kind` and `source_url` to `watch_items`,
--   • adds an index for reading tombstones.
--
-- WHAT IT NEVER TOUCHES
-- No row is deleted, no column is dropped, and progress, timestamps, PDFs, annotations,
-- "Recently deleted" entries and every file in the `video-notes` bucket stay exactly as they
-- are. Existing lessons simply keep playing as YouTube lessons (`source_kind` defaults to
-- 'youtube' and `source_url` stays empty).
--
-- Run once in Supabase SQL Editor -> New query -> Run.
-- Success message: "Success. No rows returned."

alter table public.watch_items
  add column if not exists deleted_at timestamptz,
  add column if not exists source_kind text not null default 'youtube',
  add column if not exists source_url text;

-- Reading "is this lesson deleted?" happens on every sync, so keep it cheap.
create index if not exists watch_items_user_deleted_idx
  on public.watch_items (user_id, deleted_at)
  where deleted_at is not null;

comment on column public.watch_items.deleted_at is
  'Tombstone written by "Delete forever". Cached copies of the lesson on other devices are dropped while this is set; opening the lesson again clears it.';
comment on column public.watch_items.source_kind is
  'youtube = played by the YouTube player from video_id; file = played from source_url.';
comment on column public.watch_items.source_url is
  'The direct video link of a file lesson (mp4 / m3u8 / file-host download link).';

-- Row level security already covers these columns: the policies on `watch_items` are per row
-- (`auth.uid() = user_id`) and are not column specific, so nothing else is needed here.
