# Focusframe — JEE Study Player

A responsive study desk for JEE One Shots: watch a YouTube lesson **or any direct video link**, with your timestamp chapters and PDF notes open side by side. The PDF viewer renders pages on canvas, so notes are readable inline on phones and desktop (no download prompt), and the whole app is built around one screen — video on one side, notes on the other, your library below.

**Direct video links:** paste `https://filesto.o2zone.space/d/TnYng8W`, an `.mp4`/`.webm` file, or an HLS `.m3u8` playlist and it streams in the same room — progress, chapters and notes work exactly as they do for YouTube. The browser plays the link directly; nothing is downloaded, proxied or re-hosted. These lessons get a full custom player (the YouTube-style control bar described below), and the video's first frame becomes the lesson thumbnail.

**Rename anything:** every lesson card has a pencil button — rename the lesson and move it to another subject without leaving the library. The new name syncs to your account like everything else.

**PDF library:** signed-in users can upload PDFs to a personal shelf that is not tied to any one lesson. Every PDF is private to the account, can be renamed, tagged by subject, read full screen, downloaded, or attached to the lesson on screen — and it appears on every device they sign in from.

**Built by Yash Sharma** — the credit sits in the hero byline, the site footer (linking to [github.com/Yash-4941692](https://github.com/Yash-4941692)), the no-JavaScript fallback, the social preview card, and the JSON-LD `author`/`creator` metadata, so the maker is visible to visitors, to link previews and to search engines.

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
   6. [`008_source_links_and_deletes.sql`](./supabase/migrations/008_source_links_and_deletes.sql) — **run this one so deletions reach your other devices and direct video links follow your account.** It adds `deleted_at` (the tombstone "Delete forever" writes), `source_kind` and `source_url` to `watch_items`. Without it the app still works, but the header says those two things stay on one device.

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

## Deleting a lesson (on every device)

The library has two different actions, and they are deliberately not the same thing:

- **Remove** (the bin icon on a card) only *hides* the lesson: it moves to **Removed** and can be restored from there. It never deletes a PDF that also lives in your PDF library.
- **Delete forever** (inside **Removed**) is permanent: the lesson's row, its synced drawings and its own PDF notes are deleted, and the stored PDF file is removed from your bucket.

Deleting is the one action a second device cannot see by simply *not finding* something — every
device keeps a cached copy of the library, and a missing row cannot tell that copy that a lesson
was deleted. So "delete forever" leaves a **tombstone** (`watch_items.deleted_at`): every
device reads it, hides the lesson, and never uploads its own copy again. While a tab is open the
app re-reads the account whenever the tab regains focus and every 40 seconds, so a lesson
deleted on your phone disappears on your laptop too. Opening that lesson again is the only
thing that lifts the tombstone. `npm run test:sync` includes a three-device check for exactly
this (`tools/sync-sim/lesson-delete.mjs`).

The same idea covers the PDF library: **Delete forever** on a PDF removes it for the account,
and "Recently deleted" is read from the account, so restoring a PDF on one device also takes
it out of "Recently deleted" on the others.

## Direct video links

Anything that is not a YouTube link is played by the browser's own `<video>` element straight
from the URL you pasted:

- `.mp4`, `.webm`, `.m4v`, `.mov`, `.ogv` (`.mkv` depends on the browser's codecs),
- HLS playlists (`.m3u8`) — Safari plays these natively; Chrome, Firefox and Edge get
  [hls.js](https://github.com/video-dev/hls.js), which is only downloaded when such a link is
  opened,
- file-host download links without an extension, such as `https://filesto.o2zone.space/d/TnYng8W`.

### The player

Direct links get a custom control bar (the browser's own `controls` bar is not used, because it
swallows Space and the arrow keys and cannot preview a frame while scrubbing):

- **play / pause**, the buffered range, and the played range with a draggable knob;
- **scrub preview** — hover or drag the bar and a small window shows that exact frame and its
  timestamp, like YouTube. The preview streams the same link; it is created on the first hover
  and released again after 20 s of no use;
- **time readout** (`watched / total`), **volume** slider + mute, **playback speed** — the usual
  0.5×–2× presets plus a **custom** field for anything from 0.1× to 16× (the speed you pick is
  remembered for your next lesson),
  **picture-in-picture** (where the browser supports it) and **fullscreen**;
- single click on the video plays/pauses, double click goes fullscreen, and the bar fades out
  while playing;
- **keyboard** works the same way for every lesson: `Space`/`K` play–pause, `←`/`→` seek 5 s in
  the player (`J`/`L` 10 s), `↑`/`↓` volume, `M` mute, `F` fullscreen, `C` captions,
  `Home`/`End` jump to the start/end.

### Thumbnails

A YouTube lesson borrows its picture from i.ytimg.com. A direct link has none, so the frame at
**00:01** is used — a second in, because frame zero is usually a fade-in from black. It is
produced two ways, so it works on every host:

1. **Captured and saved.** The frame is read with a canvas, shrunk to a small JPEG and stored
   as the lesson thumbnail (and the player's poster), so it shows on every device. A browser
   only allows this when the host serves the video with CORS headers.
2. **Shown live.** When the host does not send those headers (nothing on the page may read its
   pixels), the card instead holds a paused `<video>` on that same 00:01 frame. Displaying a
   video is always allowed — only reading it is not — so the thumbnail still appears; it is
   simply not saved to the account. Such hosts are remembered in the tab, so the app does not
   keep retrying them for every lesson.

A few things are up to the host, not the app: it has to serve the video **file** (a page with a
download button cannot be played), it must not require cookies or a Referer header from its own
site, and playback can be blocked if the host forbids other sites from using the file. If a link
cannot be played, the player says so and offers **Open the link** and **Try again** instead of a
blank screen. The link itself is saved with the lesson (`source_url`), so it opens on every
device you sign in from.

> YouTube lessons keep YouTube's own player, so their keyboard shortcuts work while the YouTube
> iframe itself has focus. Our shortcuts work whenever the page (not the iframe) has focus.

## Local development

```bash
npm install
npm run dev
```

### Checking lesson PDF opening

```bash
npm run test:pdf-open
```

The simulated-browser checks cover slow signed links, immediate local previews while uploads
run, lazy page editors, tab switches and background sync without reloading, and
replacement/removal, trash, and sign-out races. They run on every pull request in CI.

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
revision stamp and the realtime payload guard. A separate helper-level suite covers the
deletion/reconciliation rules (`src/lib/lessonSync.ts`) and the link parser, and
`tools/sync-sim/lesson-delete.mjs` simulates three devices around a deleted lesson.

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

### The social preview card (Linktree / WhatsApp / X / LinkedIn)

Every link preview comes from [`public/og-image.png`](./public/og-image.png) — a 1200×630 card
that carries the brand, the promise, the feature chips and **“Built by Yash Sharma”**. The same
file is `og:image`, `twitter:image` and the logo Google may show for the site. Regenerate it
after a copy change:

```bash
npm install --no-save @resvg/resvg-js
npm run build:og-image      # node tools/og-image/generate.mjs
```

The artwork lives in [`tools/og-image/generate.mjs`](./tools/og-image/generate.mjs) (plain SVG,
no design tool needed); the three latin font subsets it draws with are committed under
[`tools/og-image/fonts`](./tools/og-image/fonts) under the SIL Open Font License. After
replacing the PNG, re-scrape the page so the old card is not cached: WhatsApp and X remember
an image for days, and the [Facebook sharing debugger](https://developers.facebook.com/tools/debug/)
or [LinkedIn Post Inspector](https://www.linkedin.com/post-inspector/) will refresh it.

## Search engines (Google, Bing, and the sitemap)

The public URL is **https://focusframe.vercel.app/**. That exact host appears in the canonical
link, the Open Graph/Twitter image URLs, the JSON-LD `@id`s, `robots.txt` and the sitemap, so a
sitemap submitted in Search Console for `focusframe.vercel.app` matches the pages it lists. If
the project is ever served from a different domain, set the old one to **Redirect → 301** in
Vercel → Settings → Domains, then update the five places listed above.

Everything a crawler needs is already committed:

| File | What it does |
| --- | --- |
| [`public/robots.txt`](./public/robots.txt) | Allows every crawler and points to the sitemap. |
| [`public/sitemap.xml`](./public/sitemap.xml) | Lists the one public URL with `<lastmod>` and `priority 1.0`. |
| `index.html` `<head>` | Title, description, canonical, Open Graph/Twitter tags, author, and JSON-LD (`WebSite` + `WebApplication` + `Person` for Yash Sharma). |
| `index.html` verification meta | The `google-site-verification` tag that proves the site belongs to your Search Console account. |

Because Focusframe is a single-page app with one public route, the sitemap only ever needs that
one entry. Nothing needs to be edited by hand when the copy changes except `<lastmod>`:

```xml
<url>
  <loc>https://your-domain.example/</loc>   <!-- the canonical URL, with the trailing slash -->
  <lastmod>2026-10-30</lastmod>             <!-- YYYY-MM-DD of the last real content change -->
  <changefreq>weekly</changefreq>
  <priority>1.0</priority>
</url>
```

If the site moves to a custom domain, change the URL in **three** places: `public/sitemap.xml`
(`<loc>`), `public/robots.txt` (`Sitemap:`), and the four absolute URLs in `index.html`
(canonical, `og:url`, `og:image`, `twitter:image`) — plus the `@id`/`url` values of the JSON-LD
block. Then submit the new sitemap in Search Console.

## Notes

- YouTube videos are embedded/streamed by YouTube; the app does not download or host videos. Some owners disable embedding, in which case the player offers a link to open the video on YouTube.
- Direct video links are streamed by the browser from the URL you paste. The app never stores the video file — only the link, its progress, your timestamps and your notes.
- Keyboard shortcuts (when not typing): **Space** or **K** play/pause, **← / →** seek 10 seconds (**J / L** too), **↑ / ↓** volume, **F** fullscreen, **M** mute, and **C** captions. Inside the custom player the arrows seek 5 seconds, matching the scrubber's own step.
- There is no preloaded demo video. Guest PDF notes are intentionally session-only and are never written to localStorage; authenticated users can save PDFs to their private cloud library (`watch_items` for lesson notes, `pdf_library` for the PDF library).
- PDF notes are rendered with [PDF.js](https://mozilla.github.io/pdf.js/) on a canvas, with the reader loaded on demand and pages rendered lazily. Lesson uploads open directly from the selected file while the cloud upload runs; the same preview remains open after saving and when switching between notes and timestamps. A cached file is discarded from the viewer if the account, attachment, or trash state changes.
