-- Permit each user to assign their own subject names to lessons and PDFs.
alter table public.watch_items drop constraint if exists watch_items_subject_check;
alter table public.watch_items add constraint watch_items_subject_check check (char_length(trim(subject)) between 1 and 80);
alter table public.pdf_library drop constraint if exists pdf_library_subject_check;
alter table public.pdf_library add constraint pdf_library_subject_check check (char_length(trim(subject)) between 1 and 80);
