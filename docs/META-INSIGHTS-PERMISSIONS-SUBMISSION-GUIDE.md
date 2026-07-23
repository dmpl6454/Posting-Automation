# Meta App Review — Requesting the Insights Permissions

**Goal:** get Advanced Access for the two analytics-read permissions the Insights fix added, so Facebook and Instagram reach/impressions/clicks stop being permission-failure zeros.

| Permission | Platform | Unlocks | Status in code |
|---|---|---|---|
| **`read_insights`** | Facebook | `GET /{post}/insights` → `post_impressions`, `post_impressions_unique` (true reach), `post_clicks` | Added to `getDefaultScopes` FACEBOOK ✅ |
| **`instagram_manage_insights`** | Instagram | `GET /{ig-media}/insights` → reach, views, saved, shares | Added to `getDefaultScopes` INSTAGRAM ✅ |

> The code is already deployed-ready. Until Meta grants Advanced Access, these two scopes work only for people with a **role on the app** (admin/developer/tester) — everyone else keeps seeing `—` for the affected columns (no fake zeros). Approval flips them on for the public.

---

## Before you start — prerequisites

These are already true for this app (per CLAUDE.md), but confirm:
- App is **Live** (not in Development mode) — App Dashboard → top toggle.
- App is **Business-verified** + **Tech-Provider-verified** (both done for "Post Automation 2", App ID `298449321694397`).
- **Data Access Renewal** is current (it gates the "Submit for review" button — if it shows "Complete data access renewal requirements", clear that first; it's a separate ~10-day submission).
- Privacy Policy `https://postautomation.co.in/privacy`, Terms `/terms`, Data Deletion `/data-deletion` all return 200.

---

## Step 1 — Make one successful API call per permission (the "test call" gate)

Meta will not let you request Advanced Access for a permission until the app has made **one successful Graph API call that uses it** (≤24h to register). Do this from an **app-role account** (admin/dev/tester) that has a connected FB Page + IG Business account.

1. Deploy this branch (or a build containing the two new scopes) so a fresh connect requests them.
2. As the app-role user: **Disconnect → reconnect** the Facebook and Instagram channels (the scope change invalidates old tokens; reconnect mints tokens carrying the new scopes; `prompt`/`auth_type=rerequest` forces the grant screen).
3. Publish one test post to FB and one to IG, then open **Insights → the channel** (or wait for the analytics-sync cron) so the app calls:
   - FB: `GET /{post}/insights?metric=post_impressions,post_impressions_unique,post_clicks,...` → exercises **`read_insights`**
   - IG: `GET /{ig-media}/insights?metric=views,reach,...` → exercises **`instagram_manage_insights`**
4. Verify the calls succeeded (for the app-role user they will, since app-role users get the permissions pre-approval). Check the `pnpm dev` / worker logs — no `(#10) ... requires ... permission` or `(#200)` errors.

You can also trigger the calls directly in **Graph API Explorer** (App Dashboard → Tools → Graph API Explorer): select the app, generate a User token with the two permissions, and run the two GET calls above against a real post/media id.

## Step 2 — Request Advanced Access

App Dashboard → **App Review → Permissions and Features**. Search for each permission:

- **`read_insights`** → click **Request Advanced Access**.
- **`instagram_manage_insights`** → click **Request Advanced Access**.

(If the button is greyed out, the Step-1 test call hasn't registered yet — wait up to 24h, or the Data Access Renewal isn't cleared.)

## Step 3 — Fill in the submission

For each permission Meta asks *how* and *why* you use it. Use these (truthful, matches the code):

**`read_insights` — usage description:**
> Our web app (Facebook Login for Business, browser OAuth) lets a user connect a Facebook Page they admin and publish posts to it. On the user's own Analytics dashboard we display the performance of the user's own posts: we call `GET /{post-id}/insights` for `post_impressions`, `post_impressions_unique` (reach), and `post_clicks` on the connected Page's posts. Data is shown only to the user who owns the Page. We do not read insights for Pages the user does not administer.

**`instagram_manage_insights` — usage description:**
> Our web app lets a user connect their Instagram Professional account (linked to a Facebook Page they admin) and publish posts to it. On the user's own Analytics dashboard we display the performance of the user's own IG media: we call `GET /{ig-media-id}/insights` for reach, views, saved, and shares. Data is shown only to the account owner. We do not read insights for accounts the user does not own.

**Reviewer notes / instructions (same for both):**
> Standard web application using Facebook Login for Business with browser-based OAuth (NOT server-to-server / system-user). To test: 1) Log in at https://postautomation.co.in, 2) go to Channels and connect a Facebook Page / Instagram Business account, 3) publish a post, 4) open Insights to see the post's reach/impressions/clicks. Test credentials: <email> / <password> (rotate after review).

**Screencast:** reuse the approved `MetaNewSubmission_final.mp4` if it still shows the connect → publish → Analytics flow; otherwise record a fresh Loom showing:
1. The Facebook/Instagram permission grant screen (click "Edit settings" to force the full grant wizard, not "Continue as…").
2. Publishing a post.
3. Opening Insights and seeing the reach/impressions/clicks populate for that post.
Add audio narration or captions describing each step. Keep it under ~5 min.

## Step 4 — Submit

- Ensure **only** these two permissions (plus already-approved ones) are in the request — don't bundle anything unreviewed, it slows approval.
- Click **Submit for Review**. Processing is typically a few business days.

## Step 5 — After approval

1. **Existing FB/IG users must reconnect once** — the scope change invalidated their tokens (standard Meta behavior). Add/keep the Channels-page reconnect prompt, or they'll see the token-invalidation error on next sync.
2. **Verify on prod** it actually worked (don't trust the dashboard alone):
   ```bash
   ssh posting-automation "docker exec postautomation-postgres-1 psql -U postautomation postautomation -c \"
   SELECT platform,
     SUM(CASE WHEN reach>0 THEN 1 ELSE 0 END) AS reach_gt0,
     SUM(CASE WHEN impressions>0 THEN 1 ELSE 0 END) AS impr_gt0,
     COUNT(*)
   FROM \\\"AnalyticsSnapshot\\\"
   WHERE platform IN ('FACEBOOK','INSTAGRAM') AND \\\"snapshotAt\\\" > now() - interval '2 days'
   GROUP BY platform;\""
   ```
   Expected after approval + reconnect: `reach_gt0 > 0` and `impr_gt0 > 0` (before the fix they were 0 across every row).
3. Rotate the test credentials shared with reviewers.

## Do NOT

- Do **not** change scopes / redirect URIs during the review wait (invalidates tokens, can reset the review).
- Do **not** click "Back to testing" or "Make internal" on the Audience page (re-locks connect).
- Do **not** add `instagram_manage_comments` — Meta rejected it before (the app doesn't moderate comments).

---

## Why this is a low-risk review

Both permissions are standard analytics-read scopes held by thousands of social-management tools, and the use case ("show a user the insights of their own connected accounts") is exactly what they're designed for — a far narrower ask than the publishing permissions this app already passed. The scraper fallback (FB reels + Snapchat) means the dashboard already shows *some* real data during the review wait, so there's no outage pressure — but only these scopes make IG reach/impressions and FB feed-post reach/clicks fully real.
