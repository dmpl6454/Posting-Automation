# Meta App Setup — Facebook & Instagram Connect

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

The app requests these (App Dashboard → App Review → Permissions and Features):
- Facebook: `public_profile`, `email`, `pages_show_list`, `pages_manage_posts`,
  `pages_read_engagement`
- Instagram: the above plus `instagram_basic`, `instagram_content_publish`,
  `instagram_manage_comments`, `business_management`

`pages_manage_posts`, `instagram_content_publish`, and `business_management` are
**advanced** permissions: they work for app roles in Development mode, but require
**App Review approval** before normal users can grant them.

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
