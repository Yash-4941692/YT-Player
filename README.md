# Focusframe — JEE Study Player

A responsive YouTube study desk for JEE One Shots: native YouTube playback with your timestamp chapters and PDF notes open side by side. The PDF viewer renders pages on canvas, so notes are readable inline on phones and desktop (no download prompt), and the whole app is built around one screen — video on one side, notes on the other, your library below.

**PDF library:** signed-in users can upload PDFs to a personal shelf that is not tied to any one lesson. Every PDF is private to the account, can be renamed, tagged by subject, read full screen, downloaded, or attached to the lesson on screen — and it appears on every device they sign in from.

## Fastest way to try it (no keys or accounts)

1. In Vercel, choose **Add New → Project** and import `Yash-4941692/YT-Player`.
2. Use build command `npm run build` and output directory `dist`. Vercel usually detects Vite automatically. You do **not** need environment variables for guest mode.
3. Click **Deploy**. On the deployed URL, paste a YouTube link and open your study room.

Guest mode saves your lessons, progress and timestamps in that browser. Guest PDF files stay in memory only while the page is open, so the PDF library works for guests too but is not shared between devices. Signing in moves the PDFs uploaded in that tab into the account so they start syncing.

## Optional: one-click Google sign-in and cloud sync

The app now has a **Continue with Google** button. A new user is created automatically on their first Google sign-in; they do not have to fill out a separate sign-up form. The site owner must connect Google and Supabase once so the browser can authenticate users and safely store their cloud data. The app is static, so this backend setup cannot be skipped for secure accounts or cross-device syncing.

### 1. Create the Supabase database

1. Create a project at [supabase.com](https://supabase.com/). Keep the project URL and database password private.
2. Open the project's **SQL Editor → New query**.
3. Open [`supabase/schema.sql`](./supabase/schema.sql), copy the whole file into the query, and press **Run**. It creates the private watch/study tables, the PDF library table, access policies, and the private PDF bucket.

   **Already set up an earlier version?** Run the migration files in [`supabase/migrations`](./supabase/migrations) in this order — each one only *adds* something and leaves every existing lesson, timestamp, PDF and annotation untouched:

   1. [`002_pdf_library.sql`](./supabase/migrations/002_pdf_library.sql) — the PDF library shelf.
   2. [`003_pdf_annotations.sql`](./supabase/migrations/003_pdf_annotations.sql) — annotations drawn on library PDFs.
   3. [`005_pdf_activity_and_trash.sql`](./supabase/migrations/005_pdf_activity_and_trash.sql) — "Recently deleted" PDFs and per-PDF activity (last opened, page count).
   4. [`006_lesson_annotations.sql`](./supabase/migrations/006_lesson_annotations.sql) — annotations drawn on a **lesson's own PDF notes** (uploaded straight onto a lesson) sync across devices too, plus live updates between devices. Required for lesson notes to sync; the app keeps working locally without it.
   5. [`007_repair_watch_items.sql`](./supabase/migrations/007_repair_watch_items.sql) — **run this one if lessons or their PDFs never reached a second device.** It creates/repairs the `watch_items` table that holds every lesson, its progress, its chapters and the pointer to its PDF notes.

   > Earlier copies of `schema.sql` wrote the progress column as `current_time`. PostgreSQL treats `CURRENT_TIME` as a reserved word, so that single `CREATE TABLE` statement failed and `watch_items` (and its policies) were never created — every lesson write was then rejected, which is exactly why lessons and the PDFs attached to them did not follow your account to another device. `schema.sql` now quotes that column, and `007_repair_watch_items.sql` repairs a project created by the old file without touching a single row.

   [`004_optional_drop_legacy.sql`](./supabase/migrations/004_optional_drop_legacy.sql) is **optional**: it is never run automatically and only removes old, unused leftovers from very early versions.

   (Re-running the full `schema.sql` is also safe; it is written to be repeatable. Every file above was re-run twice against a real PostgreSQL before shipping, and each one only ever adds something.)

### 2. Create Google OAuth credentials (one time for this website)

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create/select a project.
2. Go to **Google Auth Platform** (or **APIs & Services → Credentials**, depending on the console layout). Configure the OAuth consent/branding screen and choose **External** if people outside your organization will sign in.
3. Create an **OAuth client ID → Web application**.
4. In Supabase, open **Authentication → Sign In / Providers → Google**. Copy the **Callback URL** shown there; it looks like `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`.
5. Paste that exact URL into Google's **Authorized redirect URIs**. Add your Vercel site URL, such as `https://your-project.vercel.app`, to Google's authorized JavaScript origins/authorized domains if the console asks for it.
6. Copy Google's **Client ID** and **Client secret** into Supabase's Google provider settings, enable the provider, and save. Do not put the Google client secret in Vercel or in the source code.

If Google's consent screen is still in **Testing**, add the Google accounts you want to test under **Test users**. For a public launch, finish Google's publishing/verification steps shown in that console.

### 3. Allow the Vercel URL in Supabase

In Supabase, open **Authentication → URL Configuration**:

- Set **Site URL** to your deployed Vercel URL, for example `https://your-project.vercel.app`.
- Add that same URL under **Redirect URLs**. Also add `http://localhost:5173` if you run the app locally.

Use the exact deployed domain. If you later change the Vercel domain, update this list too.

### 4. Add the Supabase values to Vercel and redeploy

In Supabase **Project Settings → API** (or **API Keys**), copy the project URL and the browser-safe **publishable/anon** key. In Vercel, open the project **Settings → Environment Variables** and add:

| Name | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | Your Supabase project URL, e.g. `https://YOUR_PROJECT_REF.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | The Supabase publishable/anon key (never the `service_role` key) |

Apply the variables to **Production** (and Preview/Development if you need those environments), save, then go to **Deployments → Redeploy**. Vite reads these values during the build, so a redeploy is required after changing them.

### 5. Sign in

Open your deployed Focusframe site, click **Sync across devices → Continue with Google**, and pick an account. First-time users are signed up automatically. Their lessons, progress, timestamp chapters and uploaded PDFs then sync through their account. PDFs are private and opened with short-lived links.

## PDF library

- Upload one or more PDFs (drag and drop or **Upload PDF**), up to 100 MB each.
- Each PDF gets a name and a Physics / Chemistry / Mathematics / Other tag; both can be edited later.
- **Open** reads it full screen with the same canvas viewer used beside the video; **Download** saves a copy.
- **Attach** (the link icon, shown while a lesson is open) links a library PDF to that lesson so it opens beside the video. Detaching a PDF from a lesson never deletes it from the library.
- Files are stored in the existing private `video-notes` bucket under `<user id>/library/…`, so no second bucket is needed.
- Guests can upload and read PDFs for the current tab only; signing in automatically moves them to the account.

### Reading and annotating a PDF

Open any PDF from the library to get the full-screen reader with an annotation bar:

- **Highlight** — select text with your finger or mouse and the highlight follows the words. If a PDF has no selectable text (a scan, for example), drag a box instead.
- **Pen**, **Rectangle**, **Ellipse** — freehand ink and shapes, with black/red/blue ink and yellow/green/pink/blue highlights.
- **Note** — tap anywhere to drop a sticky note, type, then **Save note**.
- **Eraser** — tap any annotation to delete it. **Clear all** removes everything on that PDF. Clearing is the one action that waits for an explicit **Save** (or Undo), so an accidental tap stays undoable.
- **Undo / redo** — the toolbar buttons, or **Ctrl/Cmd+Z**, **Ctrl/Cmd+Shift+Z** and **Ctrl+Y**.
- **Saving is automatic.** Every stroke, highlight, note and deletion is kept in the browser instantly and pushed to the account a moment later, plus immediately when the reader is closed, the tab is hidden or the page is left. The **Save** button is still there for an explicit write, and a Save pressed while a write is already running is queued rather than dropped; the bar shows *Unsaved changes* only until the automatic save finishes. Annotations are stored normalised (0–1 of each page), so they look the same at every zoom level and on every device.
- **Sync** — signed-in users get their annotations on every device: on open the newest copy wins (local edits the account has not seen are pushed up, otherwise the account copy loads, so deletions and clears sync too). With [`006_lesson_annotations.sql`](./supabase/migrations/006_lesson_annotations.sql) applied, a drawing saved on one device also appears live on another device that already has the same PDF open, and the same is true for **PDF notes attached to a lesson** (not just library PDFs). Guests keep annotations in the current tab only, and the reader says so. If a write to the account fails, the reader says *Saved in this browser only* instead of pretending it synced, and **retries the save itself** (1.5 s, 4 s, 10 s, 20 s, 30 s, then again on the next edit, focus, `online` event or Save press).
- **Why drawings reach the other device even when a clock is wrong.** Every save of one PDF carries a revision stamp, and each device only replaces its copy with a *newer* one. Building that stamp from the clock alone was what broke cross-device saving: a phone a few minutes fast, a laptop in another timezone or a clock that had drifted made a device's own drawing look **older** than the copy already stored, so the other device ignored it forever. The stamp is now built from the newest revision the device has actually seen (`nextRevisionStamp`), so it is always strictly newer than anything it knows about and the revision sequence for a document only moves forward. A realtime event that arrives without the document (a large `data` column can be omitted from an update event) is treated as "re-read it" rather than "this PDF is empty".
- **Missing tables are reported up front.** After sign-in the app checks for the two annotation tables and, when one is absent, says so straight away — naming the migration file to run — instead of only failing the first time a drawing is saved.

### Storage meter, Recently opened and Recently deleted

- The library header shows **"You've used X of 1 GB"**, measured from the sizes already stored in `pdf_library`.
- **Recently opened** sorts the shelf by the PDF you opened last and shows a strip of the last few; each card also shows its page count once the PDF has been opened.
- Deleting a PDF now moves it to **Recently deleted** for 30 days with a **Restore** button. **Delete forever** is what actually erases the file from storage — nothing is purged automatically without you pressing it.

The site and guest mode can be hosted without charge within the current Vercel free plan limits. Supabase and Google have their own free-tier/usage limits, which can change. The app accepts PDFs up to 100 MB, but your Supabase project's upload limit may be lower.

## Local development

```bash
npm install
npm run dev
```

### Checking that drawings still reach a second device

```bash
npm run test:sync          # everything below, one after the other
npm run test:sync:one      # one scenario: fresh | returning | lesson | flaky (add --clock-skew)
```

The checks need **Node 22 or newer** (the jsdom they drive does), and they run on every pull
request in CI. They run **two simulated devices** — each in its own process, with its own browser
profile (localStorage, cached copies) and, with `--clock-skew`, its own clock — against a
small stand-in for the Supabase REST API in [`tools/sync-sim`](./tools/sync-sim). They assert
the thing users actually care about: a drawing made on device A is on device B, and the other
way round, for library PDFs and for a lesson's own notes, when a device has an empty cache,
when both devices keep their own cached copies, and when the first account writes fail
(`flaky`) and have to be retried. `npm run test:sync` also runs the helper checks for the
revision stamp and the realtime payload guard.

### The installed-app icon

Installing the site from Chrome/Edge (⋮ → **Install Focusframe…**) opens it in its own window
with the same mint tile you see in the tab, on the taskbar, Start menu, home screen and so on.
That comes from [`public/manifest.webmanifest`](./public/manifest.webmanifest) plus the raster
icons in [`public/icons`](./public/icons) — Chrome silently falls back to a text placeholder if
the manifest or its icons are missing, so CI runs `npm run check:app-icon`, which reads the
manifest and every icon it references and fails if one is absent, the wrong size, not square,
or (for the maskable ones) not full-bleed.

The icons are generated from [`public/favicon.svg`](./public/favicon.svg), so the tab icon and
the app icon cannot drift apart. Only run this if you change the artwork; the output is
committed:

```bash
npm install --no-save @resvg/resvg-js   # on demand, keeps `npm ci` light
npm run build:app-icons
```

## Notes

- YouTube videos are embedded/streamed by YouTube; the app does not download or host videos. Some owners disable embedding, in which case the player offers a link to open the video on YouTube.
- Keyboard shortcuts (when not typing): **Space** play/pause, **← / →** seek 10 seconds, **↑ / ↓** volume, **F** fullscreen, **M** mute, and **C** captions.
- There is no preloaded demo video. Guest PDF notes are intentionally session-only and are never written to localStorage; authenticated users can save PDFs to their private cloud library (`watch_items` for lesson notes, `pdf_library` for the PDF library).
- PDF notes are rendered with [PDF.js](https://mozilla.github.io/pdf.js/) on a canvas, loaded only when a notes panel is opened. Pages render lazily, so large PDFs stay smooth on phones.
