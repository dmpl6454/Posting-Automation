# Meta Insights — Permissions State, What's Accessible, and the App Review Plan

**Status as of 2026-07-23. This is the authoritative, LIVE-TESTED handoff — supersedes any earlier "IG works for free" / "reactions work on pages_read_engagement" claims (both were wrong; see the meta-lesson at the end).**

Everything below was verified by running the **actual Graph API** with TWO tokens: an admin/operator token (`tabish@dashmani.com`) AND a **genuinely external** token (`karankumar1166dt@gmail.com`, who connected their own real FB Pages). Not inferred.

---

## 1. The definitive answer — does it work for an EXTERNAL user (karan)?

Partially, and improved by the fix shipped today (commit `1d28359`).

| FB metric | External user — BEFORE fix | External user — AFTER fix (live now) |
|---|---|---|
| **Reactions ("Likes")** | 🔴 400 → whole call returned **null → NO data at all** | ✅ **Works** — rerouted through the INSIGHTS edge (`post_reactions_by_type_total`), **no new permission** |
| **Shares** | ✅ worked | ✅ works |
| **Clicks / video views** | ✅ worked | ✅ works |
| **Comments** | 🔴 400 | ⚠️ **`—`** until `pages_read_user_content` is App-Review-approved |
| **Impressions / Reach** | gone | **`—`** — Meta DELETED these metrics; **no permission restores them** |

**The bug that was fixed:** external users got `#10 "requires pages_read_user_content"` on reactions AND comments (read via the post-FIELDS API), and the old code then **returned null, losing everything** (even the working clicks/shares/insights). The fix: reactions now come from the insights edge (external-safe), the fields fetch is **best-effort (never null)**, shares fall back to a shares-only call, and comments render `—` when unavailable.

**Why the admin's own Insights showed 0** (the screenshot): (1) the tested posts genuinely have **0 engagement** (reactions=0, comments=0), and (2) FB impressions/reach are **deleted by Meta** so those tiles are structurally `—`/0. For the ADMIN it is NOT a permission failure — it's real-zero + unavailable. (For external users it would additionally 400 on reactions/comments before the fix.)

---

## 2. Permissions actually required (tested, no conformity bias)

| Permission | Needed for | Status | Action |
|---|---|---|---|
| **`pages_read_user_content`** | FB **comments** (and fields-reactions) for **external** users | 🔴 requested in code, NOT approved | **Request via App Review** — the real FB gap |
| **`instagram_manage_insights`** | IG **reach / impressions / saved** for **external** users | 🔴 requested in code, NOT approved | **Request via App Review** (Meta v25 docs require it; admin bypasses) |
| `read_insights` | FB **clicks / video-view VALUES** | Optional | Nice-to-have; does **NOT** restore impressions/reach |
| `pages_read_engagement` | (baseline) | ✅ held & approved | — |
| `instagram_basic` | IG like_count / comments_count / media fields | ✅ held & approved | — |

All three unapproved scopes (`pages_read_user_content`, `read_insights`, `instagram_manage_insights`) are **already in the connect request** ([channel.router.ts](../packages/api/src/routers/channel.router.ts) `getDefaultScopes` FACEBOOK/INSTAGRAM). **Requesting an unapproved scope does NOT block connect** — verified: karan (external) connected fine; Meta simply doesn't grant the unapproved ones to external users.

**Corrected honest summary** (I was wrong twice before this test):
- External users get **reactions + shares + clicks NOW** (today's fix, no App Review needed).
- FB **comments** need **`pages_read_user_content`** (App Review).
- **IG insights** need **`instagram_manage_insights`** (App Review).
- FB **impressions/reach are permanently gone** — Meta deleted the metrics; no permission brings them back.

---

## 3. What is accessible today (per platform, external user, current permissions)

- **Facebook:** ✅ reactions ("likes"), shares, clicks, video views. ⚠️ comments = `—` (needs App Review). ❌ impressions/reach = `—` (deleted by Meta, permanent).
- **Instagram:** ✅ like_count, comments_count (ride on `instagram_basic`). ⚠️ reach/impressions/saved = `—` for external users (needs `instagram_manage_insights` App Review). Code correctly requests `views` not the deprecated `impressions`.
- **Everything else** (Twitter/X, YouTube, LinkedIn, Threads, Pinterest, Reddit, DevTo): unchanged by Meta review — obtainable with current per-platform integrations (X needs a paid tier for values; the rest work). Snapchat via scraper. 8 platforms (Bluesky/Discord/Mastodon/Medium/Slack/Telegram/TikTok/WordPress) have no analytics API → `—`.

---

## 4. The plan — Meta App Review (steps to follow)

**Request these two permissions** (mechanics detailed in [docs/META-INSIGHTS-PERMISSIONS-SUBMISSION-GUIDE.md](META-INSIGHTS-PERMISSIONS-SUBMISSION-GUIDE.md)):

1. **`pages_read_user_content`** — usage text: *"Display reaction and comment counts on the user's own Facebook Page posts in their analytics dashboard. Data shown only to the Page admin who connected it."*
2. **`instagram_manage_insights`** — usage text: *"Display reach, impressions, and saves for the user's own Instagram posts in their analytics dashboard. Data shown only to the account owner."*
3. **(Optional) `read_insights`** — for FB click/video-view VALUES.

**For each permission:**
1. **Trigger one test API call** (required before the "Request Advanced Access" button unlocks): on an app-role account (admin/dev/tester), publish a post and open Insights so the app calls the relevant edge (≤24h to register). If the button is greyed out, clear the **Data Access Renewal** first (separate ~10-day submission; gates the Submit button).
2. App Dashboard → **App Review → Permissions and Features** → find the permission → **Request Advanced Access**.
3. Paste the usage text above.
4. **Reviewer notes** (same for all): *"Standard web application using Facebook Login for Business with browser-based OAuth (NOT server-to-server). To test: log in at https://postautomation.co.in, connect a Facebook Page / Instagram Business account, publish a post, open Insights."* Provide test credentials.
5. **Screencast:** reuse the approved `MetaNewSubmission_final.mp4` if it still shows connect → publish → Analytics; otherwise re-record (click "Edit settings" to force the full grant screen, not "Continue as…").
6. **Submit** (only these permissions — don't bundle anything unreviewed).

**After approval:** existing FB/IG users **reconnect once** (scope change invalidates tokens). Verify on prod:
```bash
ssh posting-automation "docker exec postautomation-postgres-1 psql -U postautomation postautomation -c \"SELECT platform, SUM(CASE WHEN comments>0 THEN 1 ELSE 0 END) comments_gt0, SUM(CASE WHEN reach>0 THEN 1 ELSE 0 END) reach_gt0, COUNT(*) FROM \\\"AnalyticsSnapshot\\\" WHERE platform IN ('FACEBOOK','INSTAGRAM') AND \\\"snapshotAt\\\" > now() - interval '2 days' GROUP BY platform;\""
```
Expect FB `comments_gt0 > 0` and IG `reach_gt0 > 0` on posts that actually have engagement.

**Do NOT:** change scopes/redirect URIs during the review wait (invalidates tokens / resets review); click "Back to testing"/"Make internal"; add `instagram_manage_comments` (Meta rejected it before). Do NOT re-add any `post_impressions*` FB metric — they're deleted (requesting one 400s the whole insights call).

---

## 5. THE META-LESSON (do not repeat this mistake)

**Never conclude "it works for all users" from an admin/operator-account test.** App-role accounts (admin/developer/tester on the Meta app) receive **every REQUESTED scope at Standard Access with NO App Review** — so a permission "working" for `tabish@dashmani.com` / `sudhanshu@dashmani.com` proves *nothing* about external users. External users only get scopes that have been granted **Advanced Access via App Review**.

**The only valid proof for external behavior is a genuinely external account's token** — which is exactly what `karankumar1166dt@gmail.com` provided here, and what exposed the `pages_read_user_content` gap that two prior admin-only analyses missed.

**How to run the external test** (for the next session): find an external user's channel, read its token via a **DIRECT** `prisma.channel.findFirstOrThrow` (relation reads through `postTarget→channel` return still-ENCRYPTED `enc:v1:` ciphertext → `#190 "Cannot parse access token"`), then hit the Graph API. Run the probe as a tsx script `docker cp`'d into `postautomation-worker-1:/app/apps/worker/` and executed with `/app/node_modules/.pnpm/node_modules/.bin/tsx`.

---

**Related:** [docs/INSIGHTS-REPORTS-ACCURACY-AUDIT-2026-07-22.md](INSIGHTS-REPORTS-ACCURACY-AUDIT-2026-07-22.md) (full audit + FB deleted-metrics detail), [docs/META-INSIGHTS-PERMISSIONS-SUBMISSION-GUIDE.md](META-INSIGHTS-PERMISSIONS-SUBMISSION-GUIDE.md) (submission mechanics), memory `project-insights-metric-lineage-2026-07-22`.
