# Meta comment permissions — App Review runbook (2026-09-23)

Read and reply to Facebook Page / Instagram comments from PostAutomation, and get
the permissions approved on **both** Meta apps.

| | App ID | Who uses it | Test workspace |
|---|---|---|---|
| **App B — "Post Automation"** | `259982148841906` | only orgs pinned to it (today: **Tabish's Workspace** — 73 FB + 48 IG channels) | `tabish@dashmani.com` |
| **App A — "Post Automation 2"** | `298449321694397` | everyone else (default, `metaAppId = NULL`) | a **new** PostAutomation account (defaults to App A) |

Every claim below about Meta's rules was fetched from developers.facebook.com on
2026-09-23 and checked by a second, independent read (research workflow
`wf_cbe12111-213`). Claims about *our* tokens come from a read-only prod probe the
same day.

---

## 1. Which permissions, exactly

| Permission | What it does in our app | Graph call | App B | App A |
|---|---|---|---|---|
| `pages_read_user_content` | **Read** the comments people leave on the Page's posts (text, commenter name, replies) | `GET /{post-id}/comments` (Page token) | ❌ Rejected 2026-09-12 → **Request again** | ✅ Approved |
| `pages_manage_engagement` | **Reply** to a comment **as the Page** | `POST /{comment-id}/comments` (Page token) | 🆕 add + test call + submit | 🆕 add + test call + submit |
| `instagram_manage_comments` | **Read and reply** to comments on the IG professional account's media | `GET /{ig-media-id}/comments`, `POST /{ig-comment-id}/replies` | 🆕 add + test call + submit | 🔁 rejected 2026-06 ("Disallowed Use Case" — no feature then) → **request again** |

**Why `pages_manage_engagement` is not enough on its own:** Meta's Permissions
Reference lists **`pages_read_user_content` and `pages_show_list` as dependencies** of
`pages_manage_engagement`. On App B the rejected `pages_read_user_content` must go
in the **same** submission.

**Already approved on both apps and still required** (nothing to do):
`pages_show_list`, `pages_read_engagement`, `instagram_basic`, `business_management`.
Meta lists `instagram_basic` + `pages_read_engagement` + `pages_show_list` as
dependencies of `instagram_manage_comments`.

**Deliberately NOT requested** (requesting unused permissions is itself a rejection reason):

| Permission / feature | Why not |
|---|---|
| `pages_manage_metadata` | Only for **webhook** subscriptions (`/{page-id}/subscribed_apps`). We load comments on demand. |
| `instagram_business_manage_comments` | The **Instagram Login** equivalent. We use Facebook Login, and an app uses one login type or the other. |
| `instagram_manage_engagement` (new, 2026-04-22) | Only for **liking** media/comments. |
| `pages_messaging`, `instagram_manage_messages` | Private replies (DMs) — a different feature. |
| "Page Mentioning" feature | Only for `@[page-id]` mention tags; our replies are plain text. |

**⚠️ One conditional to watch — `ads_read`.** Meta's IG comment reference adds
"`ads_management` **or** `ads_read`" when the connecting person's role on the Page was
granted **through Business Manager**. It does not list `business_management` as an
alternative. It could not be settled from prod: Graph returns HTTP 200 on an
**empty** comment edge regardless of permissions, and none of the probe-reachable
posts had comments. **The test-call step (§3) settles it.** If an Instagram comment
load fails with *"hasn't been granted comment-reply permission"* on a freshly
reconnected account whose Page role comes via Business Manager, add `ads_read`
before submitting. Do not add it pre-emptively.

---

## 2. Before you start (one-time checks)

1. **Tech Provider (Access Verification).** Both `pages_manage_engagement` and
   `pages_read_user_content` are on Meta's Access Verification list. Verification
   belongs to the **business**, so App B inherits it **if** it is claimed by the same
   verified business as App A (Digital Sukoon Private Limited).
   *App Dashboard → App settings → Basic → "Business account"* on both apps must show
   the same business. If App B shows a different one, Meta will ask for Access
   Verification when you request these permissions.
2. **App roles.** The Facebook accounts used to connect channels for the test calls
   (demo / priyanshu / tabish) must have a **role on the app being tested**. That is
   Administrator, Developer or Tester under *App roles → Roles*, on **App B** for
   tabish's workspace and on **App A** for the new account. Only role holders can
   grant a permission before it is approved (Business apps have no Dev/Live mode).
3. **Page tasks.** The connecting person needs the **MODERATE** task ("Community
   activity") on the Page. Page **Admins** have it. Without it Meta withholds comment
   IDs, and replies are impossible.
4. **Nothing to change in "Facebook Login for Business" configurations.** We send
   permissions via the `scope` parameter (no `config_id`), which Meta still supports
   for user access tokens. Deploying the code is what adds `pages_manage_engagement`
   to the consent screen.

---

## 3. App B — "Post Automation" (resubmission, via tabish@dashmani.com)

### 3.1 Add the new permissions in the dashboard
App B → **Use cases**:
- **"Manage everything on your Page"** → *Customize* → Permissions → **Add** `pages_manage_engagement`.
  Confirm `pages_read_user_content` is listed. Status becomes *Ready for testing*.
- The **Instagram** use case (e.g. "Manage messaging & content on Instagram" — the name
  varies) → *Customize* → **Add** `instagram_manage_comments`.

If the dashboard still shows the older UI instead, use **App Review → Permissions and
Features**, search each permission, and click **Request advanced access**. It stays
greyed out until §3.3 is done.

### 3.2 Reconnect the test channels (mint tokens WITH the new permissions)
The prod probe showed the current App B tokens in Tabish's Workspace **do not
contain** `pages_manage_engagement` or `instagram_manage_comments`. Requested
permissions are only granted at consent time.

1. Log in to https://postautomation.co.in as **tabish@dashmani.com** → Tabish's Workspace.
2. **Channels** → reconnect the test **Facebook Page** → in Facebook's dialog click
   **Edit settings** (not "Continue as…") → tick the Page → approve every permission
   line → Save.
3. Reconnect the test **Instagram** account the same way.

### 3.3 Make one successful call per permission (the "test call" gate)
Meta keeps **Request advanced access** greyed out until it has logged **one successful
API call per permission**. The call must be made **within 30 days before submitting**,
and Meta says logging can take **up to 2 days**.

1. **Content Studio** → publish one post to the test Page **and** the test IG account.
   The Comments inbox only lists posts published **through PostAutomation**.
2. From a *different* Facebook profile, comment on the Facebook post; from a
   *different* Instagram account, comment on the IG post.
3. PostAutomation → **Comments** (sidebar) →
   **1.** pick the Page → **2.** pick the post → **3.** the comments load
   (**= `pages_read_user_content`**) → **Reply** → type → **Reply as ‹Page›**
   (**= `pages_manage_engagement`**). The reply appears under the comment with a
   **Page** badge.
4. Same for the Instagram account (**= `instagram_manage_comments`** — read + reply).
5. Wait. Check **App Review → Permissions and Features** ("API calls" column shows a
   green check) or the use case's successful-call count, for all three permissions.

### 3.4 Submit
1. App Review → Requests → the rejected request → **Request again** (or start a new
   request). Include **`pages_read_user_content` + `pages_manage_engagement` +
   `instagram_manage_comments`** together.
2. The new review flow asks you to re-certify allowed usage for **all** advanced
   permissions and may include Data Access Renewal questions. Reuse the answers from
   the approved renewal: processor = none, controller = Digital Sukoon Private Limited /
   India, national-security requests = No, policies = None.
3. Paste the per-permission descriptions (§6) and the reviewer instructions (§7),
   attach the screencast (§5), and submit.
4. **During the review, change nothing** in the app's settings, redirect URIs or use
   cases. Changing settings after submitting can trigger re-review.

---

## 4. App A — "Post Automation 2" (new request, via a NEW PostAutomation account)

1. **Create a new PostAutomation account** (e.g. `appreview@dashmani.com`). Its
   personal workspace uses App A by default. In `/admin → Orgs`, confirm the new
   workspace has **no Meta app override**.
2. Confirm the Facebook test accounts (demo, priyanshu) have a **role on App A**
   (App A → App roles → Roles).
3. App A → **Use cases** → add **`pages_manage_engagement`** (Page use case) and
   **`instagram_manage_comments`** (Instagram use case). `pages_read_user_content`
   is already approved there.
4. In the new account: **Channels → Connect Facebook** (Edit settings → tick the test
   Page → approve) and **Connect Instagram**.
5. Repeat §3.3 with this account: publish → comment from another profile → read +
   reply in **Comments** for both platforms. Wait up to 2 days.
6. App Review → new request with **`pages_manage_engagement` +
   `instagram_manage_comments`**. Descriptions (§6) and reviewer instructions (§7) as
   below, with the new account's login. In the notes, say plainly that the 2026-06
   `instagram_manage_comments` rejection was correct at the time (the app only showed
   comment counts) and that a real read-and-reply feature now exists.

**Existing App A users are not affected during the wait.** Requesting a
not-yet-approved permission does not block connect: non-role users are simply not
granted it. The same pattern has been live since July (insights scopes) and September
(`instagram_manage_comments`). They see an actionable "reconnect / not approved yet"
message in Comments until approval. **After approval** they must **reconnect once**,
because approval never reaches tokens issued before it.

---

## 5. Screencast script (one recording per app; same flow)

Meta's rules: **start logged out**, show the **Facebook Login for Business** button, the
person **granting** each permission, then the feature using it. **English UI**,
**1080p or better**, **captions / on-screen annotations**. Reviewers ignore audio, so
narration adds nothing. For `pages_manage_engagement` Meta explicitly wants the new
comment shown **on the Page itself**.

| # | Screen | Caption to burn in |
|---|---|---|
| 0 | postautomation.co.in logged out → log in with the test account | "PostAutomation — social media management web app. Logging in." |
| 1 | Channels → **Connect Facebook** → Facebook Login for Business → **Edit settings** → select the Page → permission list → Save | "Facebook Login for Business. The admin selects their Page and grants: read user content on the Page, manage comments on the Page." |
| 2 | Channels → **Connect Instagram** → same dialog → approve | "The admin grants Instagram comment management for their Instagram professional account." |
| 3 | Sidebar → **Comments** → **1. Page or account**: click the Page (name + picture visible) | "Step 1: the admin selects their Facebook Page. The Page's identity stays visible." |
| 4 | **2. Post**: click a post → **3. Comments** loads | "`pages_read_user_content`: the Page's comments are retrieved live from Facebook and shown with the commenter's name, text and time, labeled with the Page." |
| 5 | **Reply** → type → **Reply as ‹Page›** → reply appears with a **Page** badge | "`pages_manage_engagement`: the admin publishes a reply as the Page." |
| 6 | Click **Open ↗** → facebook.com post shows the reply | "The reply is now live on the Facebook Page." |
| 7 | Comments → select the **Instagram** account → post → comments → **Reply** → **Open ↗** on instagram.com | "`instagram_manage_comments`: reading comments on the Instagram post and replying as the account; the reply is live on Instagram." |

Tip: if the Facebook dialog shows "Continue as …", click **Edit settings** so the full
permission list is on screen. That exact omission caused the 2026-06 screencast
rejection.

---

## 6. Per-permission usage descriptions (paste into the form)

> Each permission needs its own description. Meta rejects copy-pasted text.

**`pages_read_user_content`**
> PostAutomation is a web app that lets businesses publish to and manage their Facebook
> Pages. Our Comments inbox lets a Page admin read the comments people leave on the
> posts they published through PostAutomation, so they can respond without leaving the
> dashboard. When the admin selects their Page and opens one of its posts, we call
> GET /{post-id}/comments with the Page access token and display each comment's text,
> the commenter's name, the time, like count and existing replies, clearly labeled with
> the Page. Comments are loaded only when the admin opens a post; we do not collect them
> in the background, do not store comment content, and do not use it for any other
> purpose. We also show the post's comment count in the app's Insights for posts
> published through PostAutomation.

**`pages_manage_engagement`**
> From the same Comments inbox, the Page admin can reply publicly, as their Page, to a
> specific comment on the Page's post. When the admin types a reply and clicks
> "Reply as ‹Page›", we call POST /{comment-id}/comments with the Page access token and
> the text the admin wrote. We only publish text the admin typed, only on the comment
> they chose, and only when they click the button. We never post automatically, and we
> do not like, edit, hide or delete comments.

**`instagram_manage_comments`**
> PostAutomation publishes to Instagram professional accounts connected through a
> Facebook Page. Our Comments inbox lets the account owner read the comments on the
> posts and reels they published through PostAutomation (GET /{ig-media-id}/comments,
> including the commenter's username and existing replies), and reply to a comment as
> their Instagram account (POST /{ig-comment-id}/replies) when they click
> "Reply as ‹account›". Everything happens only on the user's action. We do not send
> automated replies, and we do not hide or delete comments.
> *(App A only, add:)* Our June 2026 request for this permission was correctly rejected:
> at the time the app only displayed comment counts. The read-and-reply feature shown in
> the screencast now uses it.

---

## 7. Reviewer instructions (paste into "How to test")

> PostAutomation (https://postautomation.co.in) is a standard web app that uses
> Facebook Login for Business: browser OAuth, a user access token, then Page access
> tokens. It is NOT a server-to-server app and uses no system-user tokens.
>
> **Login (a PostAutomation account, not a Facebook account):**
> email `‹test email›` / password `‹test password›`
>
> 1. Log in. The test Facebook Page "‹Page name›" and Instagram account "@‹handle›"
>    are already connected under **Channels**. To see the login flow, click
>    **Connect Facebook**, then **Edit settings** in Facebook's dialog, select the
>    Page, and **Save**.
> 2. In the left sidebar, open **Comments**.
> 3. **Step 1:** click the Facebook Page (its name and profile picture are shown).
> 4. **Step 2:** click a post. **Step 3** loads its comments live from Facebook, with
>    the commenter's name, text and time — `pages_read_user_content`.
> 5. Click **Reply** under a comment, type a message, and click **Reply as ‹Page›**.
>    The reply appears in the thread with a "Page" badge. Click **Open ↗** to see it
>    on Facebook — `pages_manage_engagement`.
> 6. Repeat steps 3–5 with the Instagram account — `instagram_manage_comments`.
>
> If a post has no comments yet, please add one from any Facebook/Instagram account
> (use **Open ↗** to reach the post), then click **Refresh** in PostAutomation. To test
> with your own test Page, connect it under Channels, publish a post from
> **Content Studio → Compose**, comment on it, then open **Comments**.

---

## 8. After approval

- Existing FB/IG users **reconnect once** to receive the new permissions. Until then
  Comments tells them exactly that; nothing breaks.
- Rotate the test credentials used in the submission.
- Update CLAUDE.md (section "💬 Comments inbox") from "requested" to "APPROVED" for the
  app that won.

## 9. What users see when something is missing (for support)

| Message in Comments | Meaning | Fix |
|---|---|---|
| "…hasn't granted comment access yet. Reconnect…" (FB) / "…hasn't been granted comment-reply permission yet…" (IG) | The token lacks the permission: either not reconnected since the scope was added, or Meta hasn't approved it for non-role users yet | Reconnect (Edit settings, keep the Page ticked); if it still fails, it's pending approval |
| "Facebook rejected this Page's connection…" | `#190` — dead token or lost Page role | Reconnect the channel |
| "…temporarily limiting activity…" | Throttle / `#368` (too many replies too fast) | Wait a few minutes |
| "…accepted the reply but did not confirm it…" | Outcome unknown (timeout / 5xx) — the reply may be live | **Refresh first**; don't resend blindly |
| "That comment no longer exists…" | `#100/33` — deleted in the meantime | Refresh |
