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

   **Already set up an earlier version?** Run [`supabase/migrations/002_pdf_library.sql`](./supabase/migrations/002_pdf_library.sql) once instead — it only adds the new `pdf_library` table and its policies, and leaves every existing lesson, timestamp and PDF untouched. (Re-running the full `schema.sql` is also safe; it is written to be repeatable.)

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

The site and guest mode can be hosted without charge within the current Vercel free plan limits. Supabase and Google have their own free-tier/usage limits, which can change. The app accepts PDFs up to 100 MB, but your Supabase project's upload limit may be lower.

## Local development

```bash
npm install
npm run dev
```

## Notes

- YouTube videos are embedded/streamed by YouTube; the app does not download or host videos. Some owners disable embedding, in which case the player offers a link to open the video on YouTube.
- Keyboard shortcuts (when not typing): **Space** play/pause, **← / →** seek 10 seconds, **↑ / ↓** volume, **F** fullscreen, **M** mute, and **C** captions.
- There is no preloaded demo video. Guest PDF notes are intentionally session-only and are never written to localStorage; authenticated users can save PDFs to their private cloud library (`watch_items` for lesson notes, `pdf_library` for the PDF library).
- PDF notes are rendered with [PDF.js](https://mozilla.github.io/pdf.js/) on a canvas, loaded only when a notes panel is opened. Pages render lazily, so large PDFs stay smooth on phones.
