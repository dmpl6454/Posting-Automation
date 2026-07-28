# Meta App Setup — Facebook & Instagram Connect

> **Recreating a Meta app from scratch?** Use
> **[META_APP_RECREATION_GUIDE.md](META_APP_RECREATION_GUIDE.md)** instead — it is the
> full step-by-step build (products, verification, test-call gate, Data Access Renewal,
> both App Review submissions, screencast requirements, traps).
> This file is the shorter *troubleshooting* reference for the app that already exists.

The live Meta app is **"Post Automation 2"** (App ID `298449321694397`). Connecting
Facebook/Instagram from PostAutomation requires the Meta app to be configured and
(for non-test users) reviewed by Meta. This is operator configuration in the Meta
dashboard — no code change can substitute for it.

## Symptom this fixes

- **Normal users** see: *"This app isn't available — This app needs at least one
  supported permission."* and never reach consent. → App is in Development mode
  and/or the user is not a Tester, or required permissions aren't added.
- **App admins/testers** reach consent but the connect still fails in-app with
  `fb_no_pages` / `ig_no_business_account`. → The account has no admin'd Facebook
  Page, or no Instagram Professional account linked to such a Page.

## 1. Products

In the Meta App Dashboard → **Add Products**, ensure both are added:
- **Facebook Login**
- **Instagram Graph API** (for Instagram publishing via a linked Page)

## 2. Facebook Login settings

Facebook Login → Settings → **Valid OAuth Redirect URIs** must contain exactly:
- `https://postautomation.co.in/api/oauth/callback/facebook`
- `https://postautomation.co.in/api/oauth/callback/instagram`
- `http://localhost:3000/api/oauth/callback/facebook` (local dev only)
- `http://localhost:3000/api/oauth/callback/instagram` (local dev only)

(All lowercase. The app sends lowercase redirect URIs.)

## 3. Permissions / scopes

The app requests these (App Dashboard → App Review → Permissions and Features).
**Authoritative source: `getDefaultScopes()` in
[channel.router.ts](../packages/api/src/routers/channel.router.ts#L480) — if this list
and that function disagree, the code is right.**

- Facebook (6): `public_profile`, `pages_show_list`, `pages_manage_posts`,
  `pages_read_engagement`, `pages_read_user_content`, `read_insights`
- Instagram (7): `public_profile`, `pages_show_list`, `pages_read_engagement`,
  `instagram_basic`, `instagram_content_publish`, `business_management`,
  `instagram_manage_insights`

Deliberately **not** requested:
- `email` — dropped 2026-06-02; sign-in is via Google and the FB/IG providers never read it.
- `instagram_manage_comments` — dropped 2026-06-17 after Meta rejected it as a
  *Disallowed Use Case*. Comment **counts** ride on `instagram_basic`. Do not re-add
  without building real comment moderation.

All except `public_profile` are **advanced** permissions: they work for app roles
(admin/developer/tester) in Development mode, but require **App Review approval**
before normal users can grant them. The 6 publishing permissions are approved
(2026-07-17); the 3 analytics-read permissions (`pages_read_user_content`,
`read_insights`, `instagram_manage_insights`) were submitted 2026-07-24 and are pending.

## 4. Make it work for normal users — pick one

**Option A — Testing only (fastest):** Keep the app in Development mode and add each
end user under App Dashboard → **App Roles → Roles** as a *Tester* (they must accept
the invite). Test users won't see the "isn't available" error.

**Option B — Public (production):** Complete Meta **App Review** for the advanced
permissions above, complete **Business Verification**, then switch the app to **Live**
mode (toggle at the top of the dashboard). Only then can arbitrary users connect.
Review typically takes ~1–2 weeks.

## 5. Account requirements (even after the above)

The connecting user must:
- **Administer at least one Facebook Page** (personal profiles cannot be posted to
  via the API → otherwise `fb_no_pages`).
- For Instagram: have an **Instagram Professional/Business** account **linked to a
  Facebook Page** they administer (Instagram app → Settings → Account type, then link
  to the Page) → otherwise `ig_no_business_account`.

## 6. Verify

1. In an incognito window as a non-role user (Option B) or a Tester (Option A), go to
   `/dashboard/channels` → Connect Facebook. You should reach the Meta consent screen.
2. After granting, you should be redirected back with `?success=connected`.
3. If you get `fb_no_pages` / `ig_no_business_account`, fix §5 for that account.
