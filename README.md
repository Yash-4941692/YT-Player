# Focusframe — JEE Study Player

A responsive single-page YouTube study desk for JEE One Shots. It adds chapter navigation, per-video PDF notes, watch progress, timestamped revision markers, a Pomodoro timer, daily targets, and a simple study checklist while leaving YouTube's native playback controls in charge.

## Run locally

```bash
npm install
npm run dev
```

The app works immediately in guest mode. It saves chapters, watch progress, revision markers, goals, and the study plan in this browser. PDF notes stay in memory for the current page session in guest mode; no PDF is put in localStorage.

## Deploy on Vercel

1. Push/import this repository into Vercel.
2. Select the **Vite** framework preset (or let Vercel detect it).
3. Use `npm run build` as the build command and `dist` as the output directory.
4. Deploy. `vercel.json` includes the single-page-app rewrite.

No API key is needed for the guest/local version. Vercel's free plan can host the static app, subject to Vercel's current plan limits.

## Optional: accounts and cross-device sync

A static website cannot securely create accounts or sync private data by itself. For account login and cloud sync, connect a free Supabase project once:

1. Create a Supabase project and run [`supabase/schema.sql`](./supabase/schema.sql) in **SQL Editor**. It creates the watch-history/study-state tables, row-level security policies, and a private PDF bucket.
2. In Supabase **Authentication → URL Configuration**, add your local URL and the deployed Vercel URL to the allowed redirect URLs. Enable email/password sign-in. If email confirmation is enabled, users must confirm their email before first sign-in.
3. Copy the project URL and the browser-safe publishable/anon key (never the `service_role` key) into Vercel **Settings → Environment Variables**:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Redeploy. The top-right **Sync across devices** action will offer sign-up/sign-in.

After authentication, watch data, chapters, revision markers, goals, focus history, and study tasks sync to the signed-in user's private Supabase rows. PDF notes upload to a private Storage bucket and are opened with short-lived signed URLs. Guest PDFs use session-only memory. The UI caps PDFs at 100 MB; the Supabase project/plan may enforce a lower upload limit. Supabase free-tier storage and usage limits are set by Supabase and may change.

## Notes

- YouTube videos are embedded/streamed by YouTube; this project does not download or host videos. Some creators disable embeds, in which case the player explains why the video is unavailable.
- Chapter timestamps are saved per YouTube video ID. Playlist items keep their own chapters and progress.
- Keyboard shortcuts (when not typing): **Space** play/pause, **← / →** seek 10 seconds, **↑ / ↓** volume, **F** fullscreen, **M** mute, and **C** captions.
- The app includes no sample video or preloaded content.
