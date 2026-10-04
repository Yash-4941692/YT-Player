# Focusframe — JEE Study Player

A responsive YouTube study desk for JEE One Shots: native YouTube playback, per-video timestamp chapters and PDF notes, continue watching, revision markers, a Pomodoro timer, daily targets, and a topic checklist.

## Fastest way to try it (no keys or accounts)

1. Open the GitHub branch [`arena/01a1050c-yt-player`](https://github.com/Yash-4941692/YT-Player/tree/arena/01a1050c-yt-player) to see the source files. The default `main` branch may still show the original starter until the pull request is merged.
2. In Vercel, choose **Add New → Project** and import `Yash-4941692/YT-Player`.
3. If Vercel asks for a Git branch, select `arena/01a1050c-yt-player` (or merge the pull request first and use `main`).
4. Use build command `npm run build` and output directory `dist`. Vercel usually detects Vite automatically. You do **not** need environment variables for guest mode.
5. Click **Deploy**. On the deployed URL, paste a YouTube link and open your study room.

Guest mode saves video progress, chapters, revision markers, goals, and the study plan in that browser. Guest PDF files stay in memory only while the page is open. Guest data is not shared between devices.

## Optional: one-click Google sign-in and cloud sync

The app now has a **Continue with Google** button. A new user is created automatically on their first Google sign-in; they do not have to fill out a separate sign-up form. The site owner must connect Google and Supabase once so the browser can authenticate users and safely store their cloud data. The app is static, so this backend setup cannot be skipped for secure accounts or cross-device syncing.

### 1. Create the Supabase database

1. Create a project at [supabase.com](https://supabase.com/). Keep the project URL and database password private.
2. Open the project's **SQL Editor → New query**.
3. Open [`supabase/schema.sql`](./supabase/schema.sql), copy the whole file into the query, and press **Run**. It creates the private watch/study tables, access policies, and private PDF bucket.

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

Open your deployed Focusframe site, click **Sync across devices → Continue with Google**, and pick an account. First-time users are signed up automatically. Their watch history, chapters, revision markers, study goals/tasks, focus sessions, and uploaded PDFs then sync through their account. PDFs are private and opened with short-lived links.

The site and guest mode can be hosted without charge within the current Vercel free plan limits. Supabase and Google have their own free-tier/usage limits, which can change. The app accepts PDFs up to 100 MB, but your Supabase project's upload limit may be lower.

## Local development

```bash
npm install
npm run dev
```

## Notes

- YouTube videos are embedded/streamed by YouTube; the app does not download or host videos. Some owners disable embedding, in which case the player offers a link to open the video on YouTube.
- Keyboard shortcuts (when not typing): **Space** play/pause, **← / →** seek 10 seconds, **↑ / ↓** volume, **F** fullscreen, **M** mute, and **C** captions.
- There is no preloaded demo video. Guest PDF notes are intentionally session-only and are never written to localStorage; authenticated users can save PDFs to their private cloud library.
