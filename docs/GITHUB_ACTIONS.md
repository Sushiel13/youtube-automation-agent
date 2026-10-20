# Running the agent on GitHub Actions

The agent normally runs as a long-lived server with its own cron jobs. On GitHub Actions each run is short-lived, so `.github/workflows/youtube-automation.yml` calls `scripts/ci/run-once.js`, which boots the agent, runs **one** action, and exits. The SQLite database, rendered videos and thumbnails are carried between runs with the Actions cache.

## Pipeline

| Trigger | Action | What happens |
|---|---|---|
| Daily 00:31 UTC (06:01 IST) | `generate` | Strategy → script → thumbnail → SEO → voice + video render → quality checks. MP4 + thumbnail are uploaded as the `generated-media-<id>` run artifact. Status: `needs_review`. |
| Manual | `approve` | You watch the MP4, then approve it by production id. It is scheduled (or uploaded straight away if no publish time is given). |
| Every 6 hours | `publish` | Uploads any approved video whose publish time has passed. |
| Manual | `status` | Prints the recent-productions table in the run summary. |

Every run writes a summary table (production id, title, review state, schedule) to the run page.

## One-time setup

1. **Fork** this repository (forks of public repos are public — never commit `config/` or `.env`).
2. **Get YouTube OAuth tokens locally** (the browser consent step can't run in CI):
   ```bash
   npm ci
   npx playwright install chromium
   npm run credentials:setup     # choose YouTube; uses your Google Cloud "Desktop app" OAuth client
   ```
   This creates `config/credentials.json` and `config/tokens.json`. Make sure `tokens.json` contains a `refresh_token`.
3. **Add repository secrets** (Settings → Secrets and variables → Actions → Secrets):

   | Secret | Value |
   |---|---|
   | `YT_CREDENTIALS_JSON` | full contents of `config/credentials.json` |
   | `YT_TOKENS_JSON` | full contents of `config/tokens.json` |
   | `OPENAI_API_KEY` *or* `GEMINI_API_KEY` *or* `OPENROUTER_API_KEY` *or* `DEEPSEEK_API_KEY` | at least one AI provider |
   | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | optional, better voice |
   | `REPLICATE_API_TOKEN` | optional, AI video clips |
   | `NOTIFICATION_WEBHOOK_URL` | optional, Slack/Discord alerts |

4. **Add repository variables** (same page → Variables): `CHANNEL_NAME`, `DEFAULT_AUTHOR`, `TARGET_AUDIENCE`, and optionally `YOUTUBE_REGION` (default `US`), `DEFAULT_PRIVACY_STATUS` (default `private`), `VIDEO_PROVIDER` (default `slideshow`).
5. **Enable workflows** on the fork (Actions tab → "I understand my workflows, go ahead and enable them"). Scheduled workflows on forks stay off until you do this.
6. **Test it:** Actions → *YouTube Automation Pipeline* → Run workflow → action `generate`, length `short`.

## Daily flow

1. The 06:01 IST run generates a video. Open the run → download `generated-media-<id>` → watch it.
2. Happy with it? Run workflow → action `approve`, paste the production id, pick privacy, optionally a publish time.
3. It uploads immediately, or the 6-hourly `publish` run uploads it when its time comes.

## Notes

- Approving in CI confirms the agent's "fact checked" and "media rights" gates on your behalf — only approve after you've actually watched the video.
- Change the schedule by editing the two `cron:` lines; if you change the generate cron, update the matching string in the "Decide action" step too.
- The state cache is evicted if unused for 7 days and counts toward the 10 GB per-repo cache limit. Delete old `agent-state-*` caches from Actions → Caches if it grows.
- Google OAuth apps in "Testing" mode issue refresh tokens that expire after 7 days. Publish the OAuth consent screen (or re-run step 2 and update `YT_TOKENS_JSON`) if uploads start failing with `invalid_grant`.
