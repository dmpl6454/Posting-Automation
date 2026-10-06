# Meta comment permissions — App Review runbook (2026-09-23)

Read and reply to Facebook Page / Instagram comments from PostAutomation, and get
the permissions approved on **both** Meta apps.

| | App ID | Who uses it | Test workspace |
|---|---|---|---|
| **App B — "Post Automation"** | `259982148841906` | only orgs pinned to it (today: **Tabish's Workspace** — 73 FB + 48 IG channels) | `tabish@dashmani.com` |
| **App A — "Post Automation 2"** | `298449321694397` | everyone else (default, `metaAppId = NULL`) | `admin@dashmani.com` → **admin's Workspace** (verified on prod: `metaAppId` NULL = App A, not a super-admin, password login works) |

Every claim below about Meta's rules was fetched from developers.facebook.com on
2026-09-23 and checked by a second, independent read (research workflow
`wf_cbe12111-213`). Claims about *our* tokens come from a read-only prod probe the
same day. The Instagram **like** permission was added later the same day (research
workflow `wf_5bc90cb9-d84`, plus read-only prod probes — see §1).

---

## 1. Which permissions, exactly

| Permission | What it does in our app | Graph call | App B | App A |
|---|---|---|---|---|
| `pages_read_user_content` | **Read** the comments people leave on the Page's posts (text, commenter name, replies) | `GET /{post-id}/comments` (Page token) | ❌ Rejected 2026-09-12 → **Request again** | ✅ Approved |
| `pages_manage_engagement` | **Reply** as the Page, **edit/delete** the Page's own reply, **like** a comment, **hide/unhide/delete** a comment | `POST /{comment-id}/comments`, `POST /{comment-id}` (`message` / `is_hidden`), `DELETE /{comment-id}`, `POST/DELETE /{comment-id}/likes` (Page token) | 🆕 add + test call + submit | 🆕 add + test call + submit |
| `instagram_manage_comments` | **Read** comments (with commenter usernames), **reply**, **hide/unhide**, **delete** on the IG professional account's media | `GET /{ig-media-id}/comments`, `POST /{ig-comment-id}/replies`, `POST /{ig-comment-id}` (`hide`), `DELETE /{ig-comment-id}` | 🆕 add + test call + submit | 🔁 rejected 2026-06 ("Disallowed Use Case" — no feature then) → **request again** |
| `instagram_manage_engagement` (new permission, Meta changelog 2026-04-22) | **Like / unlike** a comment or reply, and **like / unlike the post itself**, as the Instagram account | `POST /{ig-user-id}/likes` and `DELETE /{ig-user-id}/likes` with `comment_id` or `media_id` (user token) | 🆕 add + test call + submit | 🆕 add + test call + submit |

**Why `pages_manage_engagement` is not enough on its own:** Meta's Permissions
Reference lists **`pages_read_user_content` and `pages_show_list` as dependencies** of
`pages_manage_engagement`. On App B the rejected `pages_read_user_content` must go
in the **same** submission.

**Already approved on both apps and still required** (nothing to do):
`pages_show_list`, `pages_read_engagement`, `instagram_basic`, `business_management`.
Meta lists `instagram_basic` + `pages_read_engagement` + `pages_show_list` as
dependencies of `instagram_manage_comments`.

**`instagram_manage_engagement` has different dependencies:** `instagram_basic`,
**`pages_read_user_content`** and `pages_show_list`. Meta's App Review page says a
dependency must be included in the same submission. On App A `pages_read_user_content`
is already approved. On App B it is in this submission anyway. The Instagram connect
now requests `pages_read_user_content` too, so a person who connects only Instagram
still grants it.

**Facts about Instagram likes, measured or from Meta's reference:**
- There is **no way to read** whether the account already liked something. The IG Comment
  object only has a `like_count`. So PostAutomation shows **Like**, and shows **Liked**
  only after it liked the comment itself in that session.
- Liking something already liked "has no effect" (Meta), and returns success. So after
  each like the app re-reads the real like count instead of adding 1.
- **Comments written by private accounts cannot be liked**, and stories cannot be liked.
  Use a comment from a **public** Instagram account for the test call and the screencast.
- More than 50 like requests in 5 seconds locks the Instagram account out for an hour.
  PostAutomation caps likes at 10 per 10 seconds per account.
- Meta refuses a token without the permission with `#100/33 "Authorization Error"`
  (probed live). The endpoint answers at our Graph version (v18.0).

**Deliberately NOT requested** (requesting unused permissions is itself a rejection reason):

| Permission / feature | Why not |
|---|---|
| `pages_manage_metadata` | Only for **webhook** subscriptions (`/{page-id}/subscribed_apps`). We load comments on demand. |
| `instagram_business_manage_comments` | The **Instagram Login** equivalent. We use Facebook Login, and an app uses one login type or the other. |
| `pages_messaging`, `instagram_manage_messages` | Private replies (DMs) — a different feature. |
| "Page Mentioning" feature | Only for `@[page-id]` mention tags; our replies are plain text. |

**⚠️ One conditional to watch — `ads_read`.** Meta's IG comment reference adds
"`ads_management` **or** `ads_read`" when the connecting person's role on the Page was
granted **through Business Manager**. It does not list `business_management` as an
alternative. This is a condition **per connecting person**, not per app: someone who
admins the Page directly never needs it, while someone whose Page role comes from a
Business portfolio might. It could not be settled from prod: Graph returns HTTP 200
on an **empty** comment edge regardless of permissions, and none of the probe-reachable
posts had comments.

**The test-call step (§3) settles it for the accounts you test with.** If an Instagram
comment load fails with *"hasn't been granted comment-reply permission"* on a freshly
reconnected account whose Page role comes through Business Manager, stop and tell
engineering. Adding `ads_read` is **not** a toggle: it is one more permission with its
own App Review and usage description, and it must be requested in code first. Do not
add it pre-emptively — requesting a permission the app visibly doesn't use is itself
a rejection reason.

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
5. **Deploying the new scope before touching the dashboard is safe.** Verified
   2026-09-23 against Facebook's live login dialog for **both** apps: the scope list
   including `pages_manage_engagement` (and the Instagram list including
   `instagram_manage_comments`) redirects normally to login. A deliberately bogus
   scope returns HTTP 500, which shows Meta checks scopes before login. So connecting
   keeps working for everyone. Only app-role accounts are granted the permission until
   it is approved. The final Instagram list, including `pages_read_user_content` and
   `instagram_manage_engagement`, was re-probed the same way on both apps. Prod data
   also shows an external account (karankumar) connecting on 2026-07-23 while an
   unapproved scope (`read_insights`) was in the request.

---

## 3. App B — "Post Automation" (resubmission, via tabish@dashmani.com)

### 3.1 Add the new permissions in the dashboard
App B → **Use cases**:
- **"Manage everything on your Page"** → *Customize* → Permissions → **Add** `pages_manage_engagement`.
  Confirm `pages_read_user_content` is listed. Status becomes *Ready for testing*.
- The **Instagram** use case ("Manage messaging and content on Instagram") → *Customize* →
  **Permissions and features** → **Add** `instagram_manage_comments` **and**
  `instagram_manage_engagement` (Meta lists the latter as an optional permission of this
  use case).

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
3. Reconnect the test **Instagram** account the same way. **If you reconnected before the
   Instagram like permission was deployed, reconnect Instagram once more** after adding
   `instagram_manage_engagement` in the dashboard. The consent screen must list a line about
   likes. Reconnecting never loses posts or history.
4. **Check it worked:** open **Comments**. A channel still missing a permission shows an
   amber **Reconnect** badge in the account list and an amber banner above its comments
   naming the missing permission. Both must be gone before you record. If only liking is
   missing, the Instagram thread shows a grey line *"Liking is off for this account…"*
   and the Like buttons are disabled. That line must be gone too.

> This is exactly what happened on 2026-09-23: the "Demo Test" Page and
> `priyanshu123321123` tokens were minted on **2026-09-19**, before the new scopes
> were requested. So the Instagram reply failed with `(#100) Missing Permission`, the
> commenter showed as "Instagram user" (Meta hides usernames without
> `instagram_manage_comments`), and Facebook had no Reply button. Reconnecting fixes all
> three.

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
4. On Facebook also click **Like**, **Hide** then **Unhide**, and **Edit** on the Page's
   own reply. These are all `pages_manage_engagement` calls, and more logged calls do no
   harm.
5. Same for the Instagram account: read, **Reply**, **Hide/Unhide**
   (**= `instagram_manage_comments`**).
6. On Instagram click **Like** on a comment from a **public** account (it turns into
   **Liked**), click again to unlike, then click **Like post** in the thread header
   (**= `instagram_manage_engagement`**).
7. Wait. Check **App Review → Permissions and Features** ("API calls" column shows a
   green check) or the use case's successful-call count, for all four permissions.

### 3.4 Submit
1. App Review → Requests → the rejected request → **Request again** (or start a new
   request). Include **`pages_read_user_content` + `pages_manage_engagement` +
   `instagram_manage_comments` + `instagram_manage_engagement`** together.
2. The new review flow asks you to re-certify allowed usage for **all** advanced
   permissions and may include Data Access Renewal questions. Reuse the answers from
   the approved renewal: processor = none, controller = Digital Sukoon Private Limited /
   India, national-security requests = No, policies = None.
3. Paste the per-permission descriptions (§6) and the reviewer instructions (§7),
   attach the screencast (§5), and submit.
4. **During the review, change nothing** in the app's settings, redirect URIs or use
   cases. Changing settings after submitting can trigger re-review.

---

## 4. App A — "Post Automation 2" (new request, via admin@dashmani.com)

1. **Test account: `admin@dashmani.com`** → its only workspace, **admin's Workspace**.
   Checked on prod 2026-09-23: the workspace has **no Meta app override**
   (`metaAppId` NULL = App A), the account is **not** a super-admin (a reviewer cannot
   reach `/admin`), the password works for email login, and the test Page "Demo Test"
   and `priyanshu123321123` are connected there on App A.
2. Confirm the Facebook test accounts (demo, priyanshu) have a **role on App A**
   (App A → App roles → Roles).
3. App A → **Use cases** → add **`pages_manage_engagement`** (Page use case), and
   **`instagram_manage_comments`** + **`instagram_manage_engagement`** (Instagram use
   case). `pages_read_user_content` is already approved there.
4. In admin's Workspace: **Channels → Connect Instagram** again (Edit settings → approve
   every line) so the token includes the like permission. Facebook was already
   reconnected with the comment permissions.
5. Repeat §3.3 with this account. The comment calls are already logged (audit log shows
   hide/unhide/reply on Instagram and like/reply on Facebook at 09:00–09:01 UTC on
   2026-09-23). Only the **Instagram like** calls are new. Wait up to 2 days.
6. App Review → new request with **`pages_manage_engagement` +
   `instagram_manage_comments` + `instagram_manage_engagement`**. Descriptions (§6) and
   reviewer instructions (§7) as below, with `admin@dashmani.com`. In the notes, say
   plainly that the 2026-06 `instagram_manage_comments` rejection was correct at the
   time (the app only showed comment counts) and that a real read-and-reply feature now
   exists.

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
| 2 | Channels → **Connect Instagram** → same dialog → **Edit settings** → permission list (comments **and likes**) → approve | "The admin grants Instagram comment management and likes for their Instagram professional account." |
| 3 | Sidebar → **Comments** → **1. Page or account**: click the Page (name + picture visible) | "Step 1: the admin selects their Facebook Page. The Page's identity stays visible." |
| 4 | **2. Post**: click a post → **3. Comments** loads | "`pages_read_user_content`: the Page's comments are retrieved live from Facebook and shown with the commenter's name, text and time, labeled with the Page." |
| 5 | **Reply** → type → **Reply as ‹Page›** → reply appears with a **Page** badge | "`pages_manage_engagement`: the admin publishes a reply as the Page." |
| 6 | On the Page's reply click **Edit** → change the text → **Save edit** | "`pages_manage_engagement`: the admin edits the Page's own comment." |
| 7 | On the user's comment click **Like** (turns to **Liked**), then **Hide** (a **Hidden** badge appears) and **Unhide** | "`pages_manage_engagement`: the Page likes a comment, and hides / unhides a comment to moderate the conversation." |
| 8 | Click **Open ↗** → facebook.com post shows the reply, the edit and the like | "The reply, edit and like are live on the Facebook Page." |
| 9 | Back in PostAutomation: **Delete** on the Page's reply → confirm | "`pages_manage_engagement`: the admin deletes a comment (after confirming)." |
| 10 | **Content Studio → Compose** → publish a photo to the test Instagram account (≈20 s; see note) | "Publishing a post to the connected Instagram account." |
| 11 | Comments → select the **Instagram** account → that post → comments (commenter @usernames visible) → **Reply** | "`instagram_manage_comments`: reading comments on the Instagram post (with usernames) and replying as the account." |
| 12 | **Hide** then **Unhide** a comment; **Delete** a test comment → confirm; **Open ↗** on instagram.com | "`instagram_manage_comments`: hiding, unhiding and deleting comments on the account's own media. The result is live on Instagram." |
| 13 | On a comment from a **public** account click **Like** (turns to **Liked**), then click **Liked** to unlike | "`instagram_manage_engagement`: the account likes, then unlikes, a comment on its post." |
| 14 | In the thread header click **Like post** (turns to **Post liked**); click again to unlike | "`instagram_manage_engagement`: the account likes, then unlikes, the post itself from its feed." |
| 15 | **Open ↗** on instagram.com — the like on the comment and on the post is visible | "The likes are live on Instagram." |

For step 2 make sure the Instagram consent screen lists the **likes** permission line
(Meta's first screencast requirement for `instagram_manage_engagement`). Steps 13–14
cover its other two requirements: a like on **media** and a like on a **comment**.

Note on step 10: the "What to include in App Review" cell for
`instagram_manage_comments` in Meta's Permissions Reference was copied from
`instagram_content_publish` and asks for a photo to be published. Showing that costs
20 seconds and satisfies the literal checklist. The **usage description must still
describe comments** (§6), not publishing.

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
> From the same Comments inbox, the Page admin engages with and moderates the
> conversation on their Page's posts, acting as the Page. They can:
> - reply to a comment (POST /{comment-id}/comments);
> - edit or delete the Page's own reply (POST /{comment-id} with message, DELETE /{comment-id});
> - like or unlike a comment as the Page (POST/DELETE /{comment-id}/likes);
> - hide, unhide or delete an abusive or spam comment (POST /{comment-id} with is_hidden,
>   DELETE /{comment-id}).
>
> Every action happens only when the admin clicks the button for that specific comment,
> uses the Page access token, and publishes only text the admin typed. Deleting asks for
> confirmation first. We never reply, like or moderate automatically.

**`instagram_manage_engagement`**
> From the same Comments inbox, the owner of an Instagram professional account
> (connected through its Facebook Page) can like the comments people leave on the posts
> and reels they published through PostAutomation, and like the post itself, acting as
> their Instagram account:
> - like or unlike a comment or a reply (POST / DELETE /{ig-user-id}/likes with comment_id);
> - like or unlike their own post or reel (POST / DELETE /{ig-user-id}/likes with media_id).
>
> This lets a business acknowledge its community quickly without leaving the dashboard.
> Every like happens only when the user clicks **Like** on that specific comment or post.
> We never like anything automatically, never like content the user did not choose, and
> never like content outside the posts they published through PostAutomation.

**`instagram_manage_comments`**
> PostAutomation publishes to Instagram professional accounts connected through a
> Facebook Page. Our Comments inbox lets the account owner manage the comments on the
> posts and reels they published through PostAutomation:
> - read them, including the commenter's username and existing replies
>   (GET /{ig-media-id}/comments);
> - reply as their Instagram account (POST /{ig-comment-id}/replies);
> - hide or unhide a comment (POST /{ig-comment-id} with hide);
> - delete a comment on their own media (DELETE /{ig-comment-id}).
>
> Everything happens only when the user clicks the button for that comment. Deleting asks
> for confirmation first. We never reply or moderate automatically.
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
> 6. Still on Facebook: click **Edit** on the Page's reply and save a change; click
>    **Like** on the user's comment; click **Hide**, then **Unhide**; click **Delete** on
>    the Page's reply and confirm — all `pages_manage_engagement`.
> 7. Repeat with the Instagram account: read (usernames shown), **Reply**,
>    **Hide/Unhide**, **Delete** — `instagram_manage_comments`.
> 8. On the Instagram thread: click **Like** under a comment (it turns into **Liked**;
>    click again to unlike), and click **Like post** in the thread header to like the
>    post itself — `instagram_manage_engagement`. Instagram does not allow liking a
>    comment written by a private account, so please use a comment from a public account.
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
| Amber **Reconnect** badge on an account / amber banner above its comments naming a permission (buttons disabled; IG names read "Instagram user (name hidden)") | PostAutomation read the channel's GRANTED scopes (recorded at connect, or checked once on first open) and the write permission isn't among them | Reconnect with Edit settings; the banner disappears |
| "…hasn't granted comment access yet. Reconnect…" (FB) / "…hasn't been granted comment permission yet (instagram_manage_comments)…" (IG) | The token lacks the permission: either not reconnected since the scope was added, or Meta hasn't approved it for non-role users yet | Reconnect (Edit settings, keep the Page ticked); if it still fails, it's pending approval |
| "Facebook rejected this Page's connection…" | `#190` — dead token or lost Page role | Reconnect the channel |
| "…temporarily limiting activity…" | Throttle / `#368` (too many replies too fast) | Wait a few minutes |
| "Reply not confirmed — it may already be posted" (toast) + amber note in the reply box, button reads **Send again anyway** | Outcome unknown: a timeout, a 5xx, Meta's `is_transient`/code 2, or our own request dropping mid-flight. The reply may be live | **Check the thread (it refreshes itself) or the post first**; only then send again |
| "There's a lot of comment activity on this Page right now…" | Our per-Page ceiling (120 reads / 30 replies per minute across all workspaces sharing the Page) | Wait a minute |
| "That comment no longer exists…" | `#100/33` on a comment — deleted in the meantime | Refresh |
| "This post is no longer available on Facebook/Instagram…" | The POST itself was deleted (or can't be loaded) | Nothing to do in PostAutomation |
| "That comment doesn't belong to this post…" | Safety check: a write may only touch comments on the post being viewed | Refresh; open the right post |
| "Change not confirmed — refreshing…" (toast) | A hide/delete/like/edit didn't confirm (timeout/5xx); it's idempotent | Look at the refreshed thread |
| Grey line "Liking is off for this account…" / Like buttons disabled (Instagram) | The channel's grant lacks `instagram_manage_engagement`. Reply/hide/delete still work | Reconnect Instagram with Edit settings; if it persists, Meta hasn't approved likes for that account yet |
| "…hasn't been granted permission to like (instagram_manage_engagement)…" | Meta refused the like for a missing permission | Same as above |
| "Instagram refused this like… written by a private account…" | The account HAS the permission, but Instagram doesn't allow liking comments from private accounts | Nothing to fix; like a comment from a public account |
| "Instagram is limiting likes for this account right now…" / "Slow down a little…" | Meta throttle, or our cap of 10 likes per 10 seconds per account (Meta locks an account for an hour above 50 in 5 s) | Wait a few seconds |
| Amber line under the thread: "Comments are turned off for this post…" (Instagram) | Someone switched comments off for that post (from PostAutomation or the Instagram app) | Click **Turn comments on** in the thread header |
| "Facebook doesn't let apps switch comments off on a Page post…" | The on/off switch is Instagram-only; Facebook has no API for it | Hide or delete individual comments instead |
| Unanswered queue: amber line "…skipped — lots of comment activity on this Page right now" | That Page's shared read budget (120 reads/min across all workspaces) was used up | Refresh in a minute |
| Unanswered queue: "May already have a reply" badge | The comment has more replies than the queue checked, so an older reply of yours may exist | Open the thread to make sure before replying |

## 10. Comments on/off and the Unanswered queue (2026-10-05)

Built after the second App Review approved `instagram_manage_comments`,
`instagram_manage_engagement` and (App B only) `pages_manage_engagement`. Neither feature
needs a new permission.

**Instagram comments on/off.** The thread header shows **Turn comments off / on** for an
Instagram post. It reads `is_comment_enabled` and writes `POST /{ig-media-id}
{comment_enabled}` (IG Media reference; live videos are not supported). Turning comments off
goes through a confirm dialog; it hides existing comments from viewers and blocks new ones,
and turning them back on restores them. Nothing is deleted. Facebook has no equivalent API.
The switch is disabled when the account lacks `instagram_manage_comments`. Audit actions:
`comment.comments_disabled` / `comment.comments_enabled` (an unknown outcome is audited with
`outcome: "unconfirmed"`).

**Unanswered queue** (`/dashboard/comments?view=unanswered`, procedure
`comment.unanswered`). It lists top-level comments on recent posts that the Page or account
has not replied to, using `selectUnanswered` in
`packages/social/src/utils/unanswered-comments.ts`:

- not written by the account itself, not hidden, and none of its embedded replies is the
  account's own;
- `repliesPartial` when a comment has more replies than were embedded (Facebook embeds the
  newest 25), shown as "May already have a reply".

Cost limits, because every post is one live Graph read on the Page's own quota, shared with
publishing:

- loads only when the Unanswered view is opened, never in the background;
- at most 12 posts per load (newest first, server cap 25), each read once, first page of
  comments only; the UI says when older posts or comments were not checked;
- every read is charged to the same per-Page read budget as the thread, and a Page over
  budget is reported as skipped, not retried;
- 3 reads in flight, 6 loads per user per minute; one post failing never fails the load.

Replies go through the existing `comment.reply` (same on-post checks, same "may already be
posted" handling). **Draft with AI** (`comment.suggestReply`) only fills the text box; a
person edits and clicks Send. The comment and caption are passed to the model as quoted data.
**Done** hides a comment from the queue in that browser only (localStorage, 45 days); nothing
is stored server-side.


## 11. Auto-hide rules and new-comment alerts (2026-10-05)

Settings live on the Comments page, **Automation** tab (`?view=automation`), one row per
workspace in `CommentAutomation`. Only workspace OWNERs and ADMINs can change them.

**How it runs.** The worker's cron leader calls `runCommentSweep`
(`apps/worker/src/lib/comment-sweep.ts`) every 15 minutes. It only looks at workspaces that
switched a feature on, and only at their published, non-story Facebook/Instagram posts from the
last 3 days. For each post it reads the first page of comments once:

- **Auto-hide** hides comments that match a blocked word or phrase, or contain a link when that
  box is ticked, as the Page or account. The matcher is `matchCommentRule`
  (`packages/social/src/utils/comment-rules.ts`): case-insensitive, NFKC-folded, whole-word for a
  plain word in any script, substring for phrases and emoji. It never touches the account's own
  comments or ones already hidden, and it checks embedded replies too. Each hide is recorded in
  `CommentAutoAction`, and **a recorded comment is never acted on again**, so a person who
  unhides it keeps it visible. Unhiding from the log (or the thread) marks the row `UNHIDDEN`.
- **Alerts** compare each post's newest comment with a watermark in
  `PostTarget.metadata.commentSweep` (`checkedAt`, `lastSeenAt`, written with an atomic jsonb
  merge). The first look at a post only sets the watermark. New visible comments produce ONE
  in-app notification per workspace per run (type `comment.new`) for owners and admins, linking
  to the Unanswered queue.

**Budget** (same Meta app quota as publishing): 40 posts per run in total, 15 per workspace,
interleaved across workspaces, stalest first; at most 50 hides per workspace per run; one read at
a time; Facebook posts are skipped for the rest of a run once Meta's reported app usage reaches
75% (`facebookAppUsagePeak`). Comment reads use the clamped interactive Graph options. A run
skips its turn if the previous one is still going. Every step is idempotent, so a deploy mid-run
is harmless.

**Env (worker, plumbed in `docker-compose.prod.yml`, all optional):**
`COMMENT_AUTOMATION_ENABLED=false` stops the sweep entirely (workspaces still opt in
individually); `COMMENT_SWEEP_MAX_POSTS`, `COMMENT_SWEEP_MAX_POSTS_PER_ORG`,
`COMMENT_SWEEP_LOOKBACK_DAYS`, `COMMENT_SWEEP_FB_USAGE_CEILING`, `COMMENT_AUTOHIDE_MAX_PER_RUN`.
Grep the worker log for `[CommentSweep]` — every run prints one accounting line.

**Permissions.** Hiding needs `pages_manage_engagement` (Facebook) or
`instagram_manage_comments` (Instagram) on the channel's token. When the recorded grant lacks it,
the sweep doesn't try; the tab names those accounts, and the run summary lists them.

**Limits.** Only the first page of comments per post is checked (Facebook: newest 25); a large
fan-out is covered gradually, a few posts per workspace per run; alerts are in-app only (no email).

## 12. Private replies and the Messages inbox (2026-10-05)

**What it does.** A **Reply privately** action on each comment sends ONE private message to the
person who wrote it, and **Messages** (`/dashboard/messages`) lists the Messenger conversations of a
Facebook Page and the Instagram Direct conversations of an Instagram account, with a composer.

**Meta's rules (enforced by Meta, mirrored in the UI and the API):**
- One private reply per comment, within 7 days of the comment. On Instagram it lands in the
  person's inbox, or in Requests if they don't follow the account.
- A message in a conversation can only be sent within 24 hours of the person's last message
  (the "standard messaging window"). The composer shows the time left and disables itself after.
- Message details are readable for the newest 20 messages of a conversation only.
- Text limits: Messenger 2,000 characters, Instagram 1,000 bytes of UTF-8.

**Permissions.**

| | needs | App A (everyone) | App B |
|---|---|---|---|
| Facebook private reply | `pages_messaging` | not requested before; now requested | now requested |
| Instagram private reply | `instagram_basic` + `instagram_manage_comments` + `pages_read_engagement` | **approved** | approved |
| Facebook inbox | `pages_messaging` + `pages_manage_metadata` + `pages_read_engagement` | now requested | now requested |
| Instagram inbox | `instagram_basic` + `instagram_manage_messages` + `pages_manage_metadata` | now requested | now requested |

So an **Instagram private reply already works for anyone** whose channel was reconnected after
`instagram_manage_comments` was approved. Everything else needs App Review. All four new scopes were
probed on both apps' live login dialog before being requested: 302 five times each (a bogus scope
returns 500). One isolated 500 on App B's Facebook dialog did not repeat in 15 tries.

**The person also needs a role on the Page that can manage messages** (the MESSAGING task); for an
Instagram account, on the Facebook Page it is linked to.

**How it works.**
- Every call uses a Page token on graph.facebook.com. An Instagram channel stores the Facebook
  user token, so the API looks up the linked Page and its token (`resolveInstagramPage`), remembers
  the Page id on the channel (`metadata.linkedPageId`, atomic jsonb merge), and caches the Page token
  in memory for 30 minutes. The Page token is never written to the database.
- Private replies are recorded in `CommentPrivateReply` (`SENT` / `UNCONFIRMED`). A `SENT` row
  refuses a second send before reaching Meta. An `UNCONFIRMED` row may be retried, because Meta itself
  refuses a second message for the same comment.
- Sending is not idempotent: a timeout, a 5xx, a transient error or an OK without an id is reported
  as "may already have been sent", never as a failure, and is never retried automatically.
- The only client value that reaches a Graph path is the conversation id. It is shape-checked
  (numeric node ids refused), encoded, and the conversation must include the account. The recipient
  of a send is read from the conversation on the server.
- Reads share the per-Page comment budget. The thread polls every 30 seconds and the list every
  60 seconds while open.

**App Review steps.** Reconnect a test Page and a test Instagram account with *Edit settings*, then
make one successful call for each permission: send a private reply from Comments (Facebook:
`pages_messaging`), open Messages for the Page and the Instagram account (`pages_manage_metadata`,
`instagram_manage_messages`), and send one message inside the 24-hour window. Screencast the
comment, the private reply arriving in Messenger / Instagram, the Messages list, a thread and a reply.

## 13. Comment sentiment on your own posts (2026-10-05)

**What it does.** With **Comment sentiment** switched on (Comments → Automation, owners and admins),
the 15-minute comment check also stores each new comment on your recent Facebook / Instagram posts
and scores it as positive, neutral, mixed or negative. Results appear in **Social Listening →
Comments on your posts** (totals, a daily chart, by account, the posts drawing the most negative
comments, and a filterable comment list that links to each thread) and as a tag on each comment in
the Comments inbox. Owners and admins get one alert when a check finds a burst of negative
comments: at least 5 negative, at least 40% of what it scored, at most one alert every 6 hours.

**How it works.**
- No extra Meta calls and no new permissions: it reuses the comments the check already reads
  (first page per post, posts of the last 3 days, up to 15 posts per workspace per run).
- `CommentSentiment` keeps one row per comment (unique per workspace + comment id). Own comments
  and comments without text are skipped. Text is truncated to 1,000 characters.
- Scoring uses the same batch prompt, parser and provider fallback chain as listening sentiment,
  20 comments per AI call, at most `COMMENT_SENTIMENT_MAX_PER_RUN` (default 200; 0 = store only)
  per run, interleaved across workspaces.
- A comment the AI returns no verdict for stays **unscored** and is retried on later runs (up to 3
  times). It is shown as "Waiting", never as a guessed neutral.
- `COMMENT_NEGATIVE_ALERT_MIN` (default 5) sets the alert threshold.

**Log line:** `docker logs postautomation-worker-1 --since 1h 2>&1 | grep -E "CommentSweep|CommentSentiment"`

## 14. Reddit comments and YouTube in social listening (2026-10-05)

Keyword listening (Social Listening → Keyword mentions) now also reads:

- **Reddit comments.** After the existing post search, each sweep opens the 5 most-discussed matching
  posts (`GET /comments/{id}`, one request each, top-level comments plus one level of replies).
  Deleted, removed, moderator and AutoModerator comments are skipped. Needs `REDDIT_CLIENT_ID` /
  `REDDIT_CLIENT_SECRET`, like Reddit posts.
- **YouTube videos and comments.** `search.list` for videos from the last 7 days matching the
  keywords, `videos.list` for their view/like/comment counts, and `commentThreads.list` (newest 50)
  on the 5 most-commented. Uses `YOUTUBE_API_KEY` when set, otherwise the workspace's connected
  YouTube channel tokens (youtube.readonly), falling over on a 401.

**Relevance rule:** a comment is kept when it names a keyword, or when the post or video it sits
under has a keyword in its title. Comment mentions carry `metadata.kind = "comment"` with the
parent's title and link, shown above the comment in the list.

**YouTube quota:** the Data API quota belongs to the Google Cloud project that also publishes
videos (an upload costs 1,600 units; a search costs 100). So YouTube listening:
- runs per query about every 6 hours (`YOUTUBE_LISTENING_EVERY_RUNS`, default 12 sweeps), or when a
  person clicks Sync Now / creates the query;
- reserves units from a daily cap (`YOUTUBE_LISTENING_DAILY_UNITS`, default 1,500, Pacific day,
  counted in Redis) before every call, and fails closed if Redis can't be reached;
- stops for the day when Google answers `quotaExceeded`.

A sweep of one keyword group costs about 106 units (100 + 1 + 5).

## 15. More public sources for social listening (2026-10-05)

New keyword-listening sources. All are free and public, and need no account or key:

| Source | Endpoint | Per sweep | Notes |
|---|---|---|---|
| Hacker News | `hn.algolia.com/api/v1/search_by_date` | 1 request per keyword (max 5) | stories and comments, last 2 days |
| Bluesky | `api.bsky.app/xrpc/app.bsky.feed.searchPosts` | 1 per keyword | `public.api.bsky.app` refuses unauthenticated search; `api.bsky.app` answers |
| Mastodon | `{instance}/api/v1/timelines/tag/{tag}` | instances × keywords | keywords become hashtags; `LISTENING_MASTODON_INSTANCES` (default `mastodon.social`) |
| Lemmy | `{instance}/api/v3/search` | 1 per keyword | posts and comments; `LISTENING_LEMMY_INSTANCE` (default `lemmy.world`) |
| Bing News | `bing.com/news/search?format=rss&count=30` | 1 per keyword | joins the "News" source; Bing returns an EMPTY feed for an OR query |
| GDELT | `api.gdeltproject.org/api/v2/doc/doc` (artlist, 1 day) | 1 per keyword group | joins "News"; one request per 6 s across the worker, skipped when the queue is longer than 20 s |

Verified live on 2026-10-05 for "openai" + "anthropic": Hacker News 60, Bluesky 50, Mastodon 80,
Lemmy 80, Bing News 28 mentions. GDELT answered the build sandbox with 503/429 (a shared address);
it is unverified there.

Queries with no platforms selected use every source, so existing "all platforms" queries pick these
up after the deploy. That means more mentions and more sentiment scoring, at 20 mentions per AI call.
Mastodon followers are stored in metadata, not as reach, so the Reach total stays comparable.

## 16. Comment sentiment on your YouTube videos (2026-10-06)

Comment sentiment (§13) now also covers videos published through PostAutomation to a workspace's
YouTube channels. It is **sentiment only**: auto-hide rules and new-comment alerts stay
Facebook/Instagram-only.

**What runs.** A workspace with Comment sentiment on is handled by the same 15-minute comment sweep
(`apps/worker/src/lib/comment-sweep.ts`). After the Facebook/Instagram pass, the sweep reads
`commentThreads.list?part=snippet,replies&order=time&maxResults=100` (the newest 100 threads plus
the replies YouTube embeds) on each recent video, using the channel's own OAuth token
(`youtube.readonly`). Comments written by our own channel are skipped. Each new comment is stored
in `CommentSentiment` with `platform = YOUTUBE` and scored with the same batch prompt.

**Which videos.**
- PostTargets that are `PUBLISHED` on a live, active YouTube channel in the automation's account
  scope.
- Published in the last 7 days.
- `publishedId` is a real 11-character video id. Community posts are skipped.
- Each video is read at most once an hour (`PostTarget.metadata.commentSweep.checkedAt`, written
  with an atomic jsonb merge), never-read videos first.
- At most 20 videos per run.

**Quota.** These reads spend YouTube Data API units from the same Google Cloud project quota as
uploads (1,600 units per upload, 10,000 per day by default):
- Each read costs 1 unit.
- A separate daily cap is counted in Redis (`comment-sentiment:yt-units:{Pacific day}`). It is
  separate from social listening's cap and fails closed when Redis doesn't answer.
- Google's `quotaExceeded` stops the pass for the rest of the Pacific day.
- `rateLimitExceeded` stops it for the current run only.

At the defaults that is at most 300 units a day, or 3% of the default project quota.

**Failures.**

| Response | Outcome |
|---|---|
| Expired or missing token | The video is not called. The token-refresh cron renews the token. |
| 401 | The channel is skipped for this run. The video is not stamped, so it is retried soon. |
| 403 `insufficientPermissions` | The token predates `youtube.readonly`. The channel is parked for 24 hours (in memory) and needs a reconnect. |
| `commentsDisabled` or `videoNotFound` | The video's own state, not an error. The video still rotates. |

**Settings and UI.**
- **Comments → Automation:** the account picker now lists YouTube channels with a "Sentiment only"
  badge.
- **Scope:** a workspace on "All" accounts includes its YouTube channels automatically. A workspace
  on "Only the ones I pick" must tick them.
- **Social Listening → Comments on your posts:** YouTube comments link to the comment on YouTube
  (`watch?v={id}&lc={commentId}`, new tab). There is no YouTube Comments inbox here, so they don't
  link into one. A YouTube post among "Most negative comments" links to the video.
- **Last run** reads "read comments on N YouTube videos".

**Env (worker; empty means default):**

| Key | Default | Range | Meaning |
|---|---|---|---|
| `COMMENT_SENTIMENT_YT_DAILY_UNITS` | 300 | 0–5000 | Units per Pacific day; 0 turns the YouTube pass off |
| `COMMENT_SENTIMENT_YT_MAX_VIDEOS` | 20 | 1–200 | Videos per run |
| `COMMENT_SENTIMENT_YT_INTERVAL_MIN` | 60 | 15–1440 | Minimum minutes between reads of one video |
| `COMMENT_SENTIMENT_YT_LOOKBACK_DAYS` | 7 | 1–30 | Videos published within this many days |

Not verified against the live API from the build sandbox: there is no YouTube token there. The
parser follows the documented `commentThread` / `comment` resources. These are the same fields
social listening's YouTube comment parser reads.

## 17. Comment sentiment on your LinkedIn Page posts (2026-10-06)

Comment sentiment now also covers posts published through PostAutomation to a workspace's
**LinkedIn Pages**. As with YouTube (§16), it is **sentiment only**: no auto-hide, no new-comment
alerts, and no Comments inbox.

**LinkedIn personal profiles are not covered.** Reading the comments on a member's own post needs
`r_member_social`, which LinkedIn grants only to approved partners. Page posts need
`r_organization_social`, which the app already requests for analytics.

**What runs.** The YouTube and LinkedIn passes now share one implementation
(`sweepExternalSentiment` in `comment-sweep.ts`). Each platform plugs in its own channel filter,
post-id check, read and response classifier. For LinkedIn:
- **Channels:** `platform = LINKEDIN` with `platformId` starting `org-`, i.e. Page channels. The
  query filters on this, and the loaded channel is checked again before any call.
- **Posts:** `publishedId` is a `urn:li:share:…` or `urn:li:ugcPost:…` from the last 7 days. Each post
  is read at most hourly, at most 20 per run.
- **Read:** `GET /rest/socialActions/{post}/comments?start=0&count=50`, with the Page channel's token
  and the provider's `LinkedIn-Version`.
- **Busy posts:** when `paging.total` is over 50, it also reads the last page (`start = total − 50`).
  The newest comments are then covered whichever order LinkedIn returns them in. That second read
  costs one more call and is skipped if the cap is reached.
- **Stored rows:** `CommentSentiment` with `platform = LINKEDIN`. The id is the comment URN. Replies
  are flagged by `parentComment`. Comments the Page itself wrote are skipped.
- **Author labels:** the versioned API returns commenters as URNs only, so comments are labelled
  "LinkedIn member" or "LinkedIn Page" rather than by name.

**Budget.**
- A daily call cap is counted in Redis (`comment-sentiment:li-calls:{day}`, default 300), separate
  from YouTube's. It fails closed when Redis doesn't answer.
- A 429 whose message names the APPLICATION **DAY** limit stops LinkedIn until midnight UTC, when
  LinkedIn's limits reset. Any other 429 stops it for the current run only.

**Failures.**

| Response | Outcome |
|---|---|
| Recorded `Channel.scopes` lacks `r_organization_social` | Skipped with no call. Reconnect the LinkedIn account. |
| 401 | Skipped for the run. |
| 403 (`ACCESS_DENIED`: missing scope, or the member no longer administers the Page) | Parked for 24 hours. |
| 404 or 410 (post deleted) | The post's own state, not an error. |

**UI.**
- **Comments → Automation:** LinkedIn Pages appear with the LinkedIn icon and a "Sentiment only"
  badge. Personal profiles are not listed.
- **Social Listening → Comments on your posts:** LinkedIn comments open the **post** on LinkedIn
  (stored `publishedUrl`, else `linkedin.com/feed/update/{urn}`). LinkedIn has no stable public
  deep link to a single comment.
- **Last run** reads "read comments on N LinkedIn posts".

**Env (worker; empty means default):**

| Key | Default | Range | Meaning |
|---|---|---|---|
| `COMMENT_SENTIMENT_LI_DAILY_CALLS` | 300 | 0–5000 | Calls per day; 0 turns LinkedIn off |
| `COMMENT_SENTIMENT_LI_MAX_POSTS` | 20 | 1–200 | Posts per run |
| `COMMENT_SENTIMENT_LI_INTERVAL_MIN` | 60 | 15–1440 | Minimum minutes between reads of one post |
| `COMMENT_SENTIMENT_LI_LOOKBACK_DAYS` | 7 | 1–30 | Posts published within this many days |

Not verified against the live API from the build sandbox, which has no LinkedIn token. The parser
follows LinkedIn's documented Comments API (`elements[].commentUrn`, `actor`, `message.text`,
`created.time`, `parentComment`, `paging.total`). Check the first runs in the worker log
(`[CommentSweep:LinkedIn]`, and `li=N` on the summary line).

## 18. Comment sentiment on replies to your X posts (2026-10-06)

Comment sentiment now also covers replies to tweets published through PostAutomation. As with
YouTube and LinkedIn (§16, §17), it is **sentiment only**: no auto-hide, no alerts, no Comments inbox.

**Cost first.** X's API has been pay-per-use since 2026-02, and there is no free tier: roughly
**$0.005 for every post read**. User objects are billed separately. Every reply this feature reads
is a charge to the X developer account behind `TWITTER_CLIENT_ID`. So the X source is the stingiest
of the three:
- **New replies only.** Each read asks only for replies newer than the newest one already seen
  (`since_id`). That reply id is kept on the post as `PostTarget.metadata.commentSweep.cursor`, so
  each reply is paid for about once. The cursor survives failed reads, so a failure never makes the
  next read start over.
- **Daily cap in posts read.** The cap is counted in replies returned (Redis
  `comment-sentiment:x-reads:{day}`, default **100/day**, about $0.50/day or $15/month at most).
  Each request reserves 25, then refunds whatever wasn't returned. An empty poll still counts as 1.
  The counter fails closed.
- **Slow cadence.** Each tweet is re-read every **3 hours**, at most 10 tweets per run, for **6 days**.
  Recent search only reaches back 7 days.
- **No author objects** (no `expansions=author_id`), so replies are labelled "X user".

**What runs.**
- `GET /2/tweets/search/recent?query=conversation_id:{tweet}&max_results=25&since_id=…&tweet.fields=author_id,created_at,conversation_id,referenced_tweets`.
- Signed with OAuth 1.0a as the channel (`TwitterProvider.searchConversationReplies`), like
  publishing and analytics. A test recomputes the signature independently from RFC 5849.
- Replies by the account itself are skipped. Leading `@handles` are stripped before scoring, and
  handle-only replies are skipped.
- A reply to a reply is flagged `isReply`.
- Rows are stored as `CommentSentiment` with `platform = TWITTER`. The id is the reply's tweet id.

**Stops and failures.**

| Response | Outcome |
|---|---|
| 402, `CreditsDepleted` or `UsageCapExceeded` (credits or monthly cap spent) | Stops X until midnight UTC |
| 403 `client-not-enrolled` (the app isn't allowed recent search) | Stops X until midnight UTC |
| Other 429 | Stops X for the current run |
| 401 | The channel is skipped for the run |
| Other 403 | The channel is parked for 24 hours |

**UI.**
- **Comments → Automation:** X accounts appear with the X icon and a "Sentiment only" badge. The
  copy says X replies are read within a small budget because X charges per read.
- **Social Listening → Comments on your posts:** X replies open the **reply itself**
  (`x.com/i/status/{id}`). A post among "Most negative comments" opens the tweet.
- **Last run** reads "read replies on N X posts".

**Env (worker; empty means default):**

| Key | Default | Range | Meaning |
|---|---|---|---|
| `COMMENT_SENTIMENT_X_DAILY_READS` | 100 | 0–5000 | Posts read per day; 0 turns X off |
| `COMMENT_SENTIMENT_X_MAX_POSTS` | 10 | 1–200 | Tweets per run |
| `COMMENT_SENTIMENT_X_INTERVAL_MIN` | 180 | 15–1440 | Minimum minutes between reads of one tweet |
| `COMMENT_SENTIMENT_X_LOOKBACK_DAYS` | 6 | 1–7 | Tweets published within this many days |

**Turning it off for X only:** set `COMMENT_SENTIMENT_X_DAILY_READS=0` in `.env.production` and
redeploy (or restart the worker).

Not verified against the live API from the build sandbox, which has no X user token. Check the first
runs in the worker log (`[CommentSweep:X]`, and `x=N` on the summary line). Watch the X developer
portal's usage page the first day.

## 19. Social Listening feed: sort and filter by reach/views (2026-10-06)

The Social Listening mention feed can now be **sorted by reach** ("Most reach") and **filtered by a
minimum reach** (1K+, 10K+, 100K+ or 1M+) and a **period** (24 hours, 7 days, 30 days or all time).
The choices live in the URL (`?sort=reach&minReach=10000&period=7`), so a filtered feed can be shared
and survives a reload. The feed also pages now ("Load more", 20 at a time; it used to show only the
latest 20).

**What "reach" is.** It is whatever the source reports for a mention, labelled on each card:

| Source | Reach shown as |
|---|---|
| YouTube, TikTok | Views |
| X | Impressions |
| Reddit posts | Upvotes |
| Every other source (news, Hacker News, Bluesky, Mastodon, Lemmy, Facebook, Instagram, LinkedIn, comments) | Nothing; they store 0 ("not reported") |

Sources that report nothing sort last under "Most reach" and are hidden by any minimum. The page
says so whenever either control is in use.

**API.** `listening.mentions` takes:
- `sort` (`recent` | `reach`, default `recent`);
- `minReach` (default 0);
- `days` (1–365, omitted = all).

Pagination is now Prisma cursor paging (`cursor: { id }, skip: 1`) over a total order:
- `recent` orders by `mentionedAt desc, id desc`;
- `reach` orders by `reach desc, mentionedAt desc, id desc`.

The old `id < cursor` paging only worked by accident: ids aren't ordered by `mentionedAt`.
`listening.mentions` has no other caller.

**Schema.** New plain index `Mention(listeningQueryId, reach)` for the per-query reach sort. It is
non-unique, so `db push` adds it to the populated table without data loss.

**Tests.**
- `listening-mentions-sort.e2e.test.ts` (real Postgres; `LIVE_E2E=1`) pages through seeded rows
  with reach ties, zero reach, an out-of-period row and another workspace's high-reach rows. Every
  row comes back exactly once, in order, and the workspace scope holds.
- `listening-mentions-sort.test.ts` pins the query shape.
- `apps/web/lib/listening-feed.test.ts` covers URL parsing, labels and the page contract.

## 20. Social Listening feed: filter by overall sentiment (2026-10-06)

The mention feed can also be narrowed to one overall sentiment. There are two ways in:
- **Chips** in the feed's filter row: All, Positive, Neutral, Negative, Mixed.
- **The Sentiment Distribution legend:** click "Negative 24%" to show only negative mentions; click
  it again to clear.

Both set the same filter. It is kept in the URL (`?sentiment=negative`, lower-case) alongside the
reach/period filters (§19), so links can be shared. Reset clears everything.

- **No API or schema change.** `listening.mentions` already took `sentiment`, and the page now sends
  it. A router test checks that it combines with the reach filters and that unknown values are
  refused.
- **Mixed is offered** because the classifier produces it and the distribution bar shows it.
  Without a chip, those mentions couldn't be singled out.
- **Neutral includes mentions not yet scored.** New mentions are stored as NEUTRAL until the
  sentiment worker scores them, minutes later in a 20-per-call batch.
- **Neutral also includes failed scoring.** The light scorer writes NEUTRAL with score 0 when every
  AI provider fails.
- Both of those are the same set the distribution bar counts as Neutral.
