# OAuth Setup Guide (Operator)

This guide is for **you, the platform operator** — the person running PostAutomation. You do this **once per platform**, not per user. After you finish, your users can connect their own accounts by clicking "Connect" on the channels page.

## How OAuth works (a 30-second refresher)

PostAutomation is the same kind of OAuth client as Buffer or Hootsuite. **You** register one OAuth app per social platform under your developer/business account. **Your users** then click "Connect Twitter" (or whatever), sign into **their own** Twitter, and Twitter shows them *"PostAutomation wants to post on your behalf — Allow?"*. They click Allow, and PostAutomation gets a token to post to their account.

The user **never sees your CLIENT_ID/SECRET**. They never visit a developer portal. They don't know OAuth exists. They just see the platform's normal sign-in screen.

This is identical to how `Sign in with Google` already works on `postautomation.co.in` — you have one Google OAuth client registered (`956743108230-...`), all users sign in through it using their personal Gmail accounts.

---

## Setup workflow for every platform

1. Register an OAuth app on the platform's developer portal.
2. Configure the redirect/callback URL to point at PostAutomation.
3. Copy the CLIENT_ID and CLIENT_SECRET into `.env` (local) and `.env.prod` (production).
4. Restart the dev server (local) or run `bash scripts/deploy.sh deploy` (production).
5. The Connect button on `/dashboard/channels` lights up. Done.

**Local callback** is always `http://localhost:3000/api/oauth/callback/<provider>`.
**Production callback** is always `https://postautomation.co.in/api/oauth/callback/<provider>`.

Add **both** URLs to every developer portal so local dev and production share one app.

> Naming note: developer portals call it variously "Authorised redirect URI", "Redirect URL", "Callback URL", or "Valid OAuth Redirect URIs". They all mean the same thing.

---

## Platform-by-platform

Order is "easiest first" — start at the top and work down.

### 1. Twitter / X (1-2 hours, no review)

**Difficulty:** Easy. **Review wait:** None for basic tweet posting.

1. Go to [developer.twitter.com/en/portal](https://developer.twitter.com/en/portal/dashboard) and sign in with the Twitter account you want as the operator account.
2. Create a Project, then create an App inside it. Give it a name like "PostAutomation".
3. In the App settings → **User authentication settings** → **Set up**:
   - **App permissions**: `Read and write` (or `Read and write and Direct message` if you want DM support later)
   - **Type of App**: Web App
   - **App info → Callback URI / Redirect URL**:
     ```
     http://localhost:3000/api/oauth/callback/twitter
     https://postautomation.co.in/api/oauth/callback/twitter
     ```
   - **App info → Website URL**: `https://postautomation.co.in`
4. Save. You'll see the OAuth 2.0 Client ID and Client Secret (we use OAuth 1.0a *and* OAuth 2.0 — the same `Consumer Keys` work for both).
5. Now go to **Keys and tokens** tab → **Consumer Keys** → Regenerate. Copy:
   - **API Key** → `TWITTER_CLIENT_ID`
   - **API Key Secret** → `TWITTER_CLIENT_SECRET`
6. Paste both into `.env` and `.env.prod`.

```bash
TWITTER_CLIENT_ID="your-api-key"
TWITTER_CLIENT_SECRET="your-api-key-secret"
```

### 2. LinkedIn (1-3 days, basic review)

**Difficulty:** Easy. **Review wait:** Same-day for `w_member_social`; up to 1 week for organization posting.

1. Go to [linkedin.com/developers/apps](https://www.linkedin.com/developers/apps) and click **Create app**.
2. Fill out:
   - **App name**: PostAutomation
   - **Company**: Your business page on LinkedIn (or create one — required)
   - **Privacy policy URL**: `https://postautomation.co.in/privacy`
   - **App logo**: upload a square logo
3. After creation, in the **Auth** tab:
   - **Authorized redirect URLs**:
     ```
     http://localhost:3000/api/oauth/callback/linkedin
     https://postautomation.co.in/api/oauth/callback/linkedin
     ```
4. In **Products** tab, request access to:
   - **Sign In with LinkedIn using OpenID Connect** (instant)
   - **Share on LinkedIn** (instant)
   - **Marketing Developer Platform** (only if you want Company Page posting — manual review)
5. Back in **Auth** → **OAuth 2.0 settings** → copy:
   - **Client ID** → `LINKEDIN_CLIENT_ID`
   - **Client Secret** → `LINKEDIN_CLIENT_SECRET`
6. Paste both into `.env` and `.env.prod`.

### 3. Pinterest (1 day - 1 week)

**Difficulty:** Easy. **Review wait:** Trial access is instant; production needs Pinterest's approval.

1. Go to [developers.pinterest.com](https://developers.pinterest.com/apps/) and sign in with a Pinterest business account (convert your personal account if needed).
2. Click **Create app**.
3. Fill out:
   - **App name**: PostAutomation
   - **App description**: "Multi-channel social posting platform"
   - **Website URL**: `https://postautomation.co.in`
   - **Redirect URIs**:
     ```
     http://localhost:3000/api/oauth/callback/pinterest
     https://postautomation.co.in/api/oauth/callback/pinterest
     ```
4. Submit. Your app starts in **Trial** mode — works for accounts you add manually as test users.
5. From the app dashboard, copy:
   - **App ID** → `PINTEREST_CLIENT_ID`
   - **App secret key** → `PINTEREST_CLIENT_SECRET`
6. To leave trial mode, submit for review via the dashboard — Pinterest typically responds within a week.

### 4. Reddit (Same-day)

**Difficulty:** Easy. **Review wait:** None.

1. Go to [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) (sign in with the Reddit account that will own the app).
2. Scroll to the bottom, click **are you a developer? create an app...**
3. Fill out:
   - **name**: PostAutomation
   - Choose type: **web app**
   - **description**: Multi-channel social posting
   - **about url**: `https://postautomation.co.in`
   - **redirect uri**: `https://postautomation.co.in/api/oauth/callback/reddit`
4. Click **create app**. Note: Reddit only allows **one** redirect URI per app — pick production. For local dev, register a second app with the localhost URI:
   ```
   http://localhost:3000/api/oauth/callback/reddit
   ```
   ...and use that app's keys in your local `.env`.
5. Copy:
   - String just under "personal use script" → `REDDIT_CLIENT_ID`
   - **secret** → `REDDIT_CLIENT_SECRET`

> Reddit also wants a User-Agent header set in API calls. The provider already does that, no action needed.

### 5. YouTube (1-2 weeks, Google verification)

**Difficulty:** Medium. **Review wait:** 1-2 weeks for OAuth verification once you request `youtube.upload` scope in production. **You can self-test before verification.**

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) — **use the same project you already have** for `Sign in with Google` (the one with client ID `956743108230-...`).
2. In the left menu, search for **YouTube Data API v3** and click **Enable**.
3. Go to **APIs & Services → OAuth consent screen**. You already configured this for sign-in. Click **Edit App**.
4. **Scopes** step → **Add or remove scopes** → search for and add:
   - `https://www.googleapis.com/auth/youtube.upload`
   - `https://www.googleapis.com/auth/youtube`
   - `https://www.googleapis.com/auth/youtube.readonly`
5. Save.
6. Go to **APIs & Services → Credentials** → click **Create Credentials → OAuth client ID**.
   - **Application type**: Web application
   - **Name**: PostAutomation YouTube
   - **Authorized redirect URIs**:
     ```
     http://localhost:3000/api/oauth/callback/youtube
     https://postautomation.co.in/api/oauth/callback/youtube
     ```
7. Save. Copy:
   - **Client ID** → `YOUTUBE_CLIENT_ID`
   - **Client secret** → `YOUTUBE_CLIENT_SECRET`

> **Testing before verification**: Google lets you test the unverified app against accounts on your "Test users" list (Cloud Console → OAuth consent screen → Test users → Add). Add your own YouTube account here. To go production for unlimited users, submit for verification via the OAuth consent screen — Google reviews uploads scope use within ~2 weeks.

### 6. TikTok (1-3 weeks)

**Difficulty:** Medium. **Review wait:** 1-3 weeks per scope.

1. Go to [developers.tiktok.com](https://developers.tiktok.com/apps/) → **Manage apps** → **Connect an app**.
2. Fill out the app form. For posting, you specifically need:
   - **App name**: PostAutomation
   - **App description**: Multi-channel social posting platform
   - **Category**: Tools & Productivity (or similar)
   - **Platform**: Web
   - **App URL**: `https://postautomation.co.in`
   - **Privacy policy URL**, **Terms of Service URL**: must be real, accessible pages
3. In **Products**, add:
   - **Login Kit** (for OAuth sign-in)
   - **Content Posting API** (this is what TikTok wants to review — submit it once the basic app is ready)
4. In **Login Kit → Redirect URIs**:
   ```
   http://localhost:3000/api/oauth/callback/tiktok
   https://postautomation.co.in/api/oauth/callback/tiktok
   ```
5. Copy from the app's main page:
   - **Client Key** → `TIKTOK_CLIENT_KEY`
   - **Client Secret** → `TIKTOK_CLIENT_SECRET`
6. Submit **Content Posting API** for review. TikTok typically wants a demo video showing your app uploading content.

> Note: The codebase uses `client_key` (TikTok's specific naming) — not `client_id`. The env var name reflects this.

### 7. Facebook + Instagram (2-6 weeks, Meta Business Verification)

**Difficulty:** Hard. **Review wait:** Business Verification can take 1-3 weeks alone; App Review for content publishing adds another 1-3 weeks.

This is the most involved registration. Facebook and Instagram share the same Meta developer portal and the same app.

1. Go to [developers.facebook.com](https://developers.facebook.com/apps/) and click **Create App**.
2. Use case: **Other** → Type: **Business** → fill out app name, contact email, business account.
3. In the app dashboard, click **Add Product** and add:
   - **Facebook Login for Business** (for the OAuth flow)
   - **Pages API** (for posting to Pages)
   - **Instagram Graph API** (for posting to Instagram Business / Creator accounts)
4. **Facebook Login for Business → Settings → Valid OAuth Redirect URIs**:
   ```
   http://localhost:3000/api/oauth/callback/facebook
   https://postautomation.co.in/api/oauth/callback/facebook
   http://localhost:3000/api/oauth/callback/instagram
   https://postautomation.co.in/api/oauth/callback/instagram
   ```
   (Facebook and Instagram share the OAuth callbacks — this is correct.)
5. **App Settings → Basic** — fill out:
   - **Privacy Policy URL**: `https://postautomation.co.in/privacy` (must be a real public page)
   - **Terms of Service URL**: `https://postautomation.co.in/terms`
   - **User Data Deletion URL** or instructions (required by Meta)
   - **App Icon**: 1024x1024 PNG
   - **Category**: Business and Pages → Social Networking
6. Copy from **Settings → Basic**:
   - **App ID** → both `FACEBOOK_APP_ID` and `INSTAGRAM_CLIENT_ID`
   - **App secret** → both `FACEBOOK_APP_SECRET` and `INSTAGRAM_CLIENT_SECRET`

   (Yes, same credentials. The env var split is purely to match the code's `<PLATFORM>_CLIENT_*` convention.)

7. **App Review → Permissions and Features** — request:
   - `pages_show_list`
   - `pages_manage_posts`
   - `pages_read_engagement`
   - `instagram_basic`
   - `instagram_content_publish`
   - `business_management`

   For each, you must:
   - Click **Edit Settings** and fill out the "How will you use this permission?" form.
   - Record a screen-capture demo video showing PostAutomation posting via that scope.
   - Submit.

8. Complete **Business Verification** in **Meta Business Suite**. You upload business documents (incorporation, address, etc). Meta typically responds in 1-2 weeks.

> **Testing before review**: In dev mode, your app can post to FB Pages and IG accounts owned by people listed as admins/developers/testers of the app (max ~25). That's enough to validate end-to-end posting locally.

### 8. Threads (via Meta — submit during Facebook review)

Threads uses Meta's developer portal and shares the Facebook app you created in step 7. After your Meta app is set up, add the **Threads API** product to the same app and request:
- `threads_basic`
- `threads_content_publish`

Same env vars as Facebook reuse:
```bash
THREADS_CLIENT_ID="$FACEBOOK_APP_ID"
THREADS_CLIENT_SECRET="$FACEBOOK_APP_SECRET"
```

Add redirect URIs:
```
http://localhost:3000/api/oauth/callback/threads
https://postautomation.co.in/api/oauth/callback/threads
```

Review timeline is the same as Facebook (1-3 weeks).

### 9. Slack (1 day)

**Difficulty:** Easy. **Review wait:** None for posting to workspaces where you're an admin; Slack App Directory submission is optional and takes ~2-4 weeks.

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**.
2. App name: PostAutomation. Workspace: your business workspace.
3. **OAuth & Permissions → Redirect URLs**:
   ```
   http://localhost:3000/api/oauth/callback/slack
   https://postautomation.co.in/api/oauth/callback/slack
   ```
4. **Scopes → Bot Token Scopes**: add `chat:write`, `chat:write.public`, `files:write`, `channels:read`.
5. Install the app to your workspace.
6. Copy from **Basic Information → App Credentials**:
   - **Client ID** → `SLACK_CLIENT_ID`
   - **Client Secret** → `SLACK_CLIENT_SECRET`

> Slack also supports incoming webhooks as a simpler alternative — same pattern as Discord. If you want webhook-only support added to the token-based connect dialog, ping me; the existing Slack provider can be extended the same way Discord was.

---

## After registering: where to put credentials

For **every** platform you finish, append the two env vars to both:

**Local** — `.env`:
```bash
TWITTER_CLIENT_ID="..."
TWITTER_CLIENT_SECRET="..."
LINKEDIN_CLIENT_ID="..."
LINKEDIN_CLIENT_SECRET="..."
# ...etc per platform you've registered
```

**Production** — on the server, edit `/home/deploy/postautomation/.env.prod`:
```bash
ssh posting-automation
cd /home/deploy/postautomation
nano .env.prod
# add the new keys, save, then:
bash scripts/deploy.sh deploy
```

After redeploy, the platform's "Setup required" amber badge on `/dashboard/channels` flips to a normal Connect button. Users (and you) can now click Connect and authorize via the standard OAuth flow.

---

## Snapchat (not yet supported)

The codebase has no Snapchat provider. To add it, you'd need:
1. Register a Snap Kit app at [kit.snapchat.com/portal](https://kit.snapchat.com/portal). Request Creative Kit scopes for posting Stories/Snaps.
2. Add a `packages/social/src/providers/snapchat.provider.ts` implementing `getOAuthUrl`, `exchangeCodeForTokens`, `publishPost`, `getProfile`.
3. Register the provider in `packages/social/src/abstract/social.factory.ts`.
4. Add `SNAPCHAT` to the `SocialPlatform` enum in `packages/db/prisma/schema.prisma` and run `pnpm db:push`.

Estimated dev work: 1-2 days. Snap Kit review timeline: 1-3 weeks.

---

## Token-based platforms (no OAuth registration needed)

These work immediately, no developer portal involved. Just click Connect on the channels page and paste credentials:

| Platform | Where to get credentials |
|---|---|
| **Telegram** | DM [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token |
| **Discord** | Channel → Edit → Integrations → Webhooks → Copy URL |
| **Bluesky** | [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords) |
| **Mastodon** | Your instance → Preferences → Development → New application |
| **WordPress** (self-hosted) | Users → Profile → Application Passwords |
| **Dev.to** | [dev.to/settings/extensions](https://dev.to/settings/extensions) |
| **Medium** | Existing integration token only (Medium stopped issuing new ones in 2023) |

---

## Common errors and fixes

| Error in callback | Cause | Fix |
|---|---|---|
| `redirect_uri_mismatch` | The platform doesn't have the URL we redirected to in its allow-list | Add the exact URL (including http/https + port) to the platform's redirect URI list |
| `invalid_client` | CLIENT_ID/SECRET mismatch or wrong env | Re-paste the credentials; make sure local uses `.env`, production uses `.env.prod` |
| `Invalid scope` | The scope you're requesting isn't enabled on the app | Go back to the developer portal, request the scope, and resubmit if review is required |
| OAuth login works but posting fails | Scope was granted for sign-in but not for posting | Re-authorize with the right scopes; for FB/IG/TikTok this means waiting for App Review |
| "App not yet verified" warning page | Google/Meta unverified app screen | Add your test account to the app's test users list (Cloud Console → OAuth consent screen → Test users) OR submit for verification |

---

## Total time investment

| Platform | Registration | Review wait | Operator effort |
|---|---|---|---|
| Twitter | 1-2 hours | None | Easy |
| Reddit | 30 min | None | Easy |
| LinkedIn | 1 hour | None - 1 week | Easy |
| Pinterest | 1 hour | None - 1 week | Easy |
| Slack | 30 min | None | Easy |
| YouTube | 1-2 hours | None for self-test, 1-2 weeks for production | Medium |
| TikTok | 2-3 hours | 1-3 weeks | Medium |
| Facebook + Instagram | 3-4 hours | 2-6 weeks (business verification + app review) | Hard |
| Threads | 1 hour (uses FB app) | Same as Facebook | Easy if FB done |

**Recommended order**: Twitter → Reddit → LinkedIn → Pinterest → Slack → YouTube → TikTok → Meta (parallel-start the long Meta review while you finish the others).
