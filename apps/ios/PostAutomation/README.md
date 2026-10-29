# PostAutomation iOS

Native **SwiftUI** companion app (iOS 17+) for the PostAutomation platform. It
talks to the **live** tRPC API at `https://postautomation.co.in` using the same
NextAuth session cookie the web app uses — **no backend changes are required**
for anything in v1.0.

## What it does (v1.0)

| Tab | Backed by | Notes |
|---|---|---|
| Home | `analytics.dashboardStats`, `notification.unreadCount` | Four lifetime stat cards + cumulative sparklines; bell with the unread count; the tab badge shows unread notifications |
| Notifications (from Home) | `notification.list`, `markRead`, `markAllRead`, `post.getById` | Publish results and approvals; tapping a publish notification opens the post in-app |
| Posts | `post.list`, `post.publishNow`, `post.delete` | Status filter chips, cursor pagination, attached media, per-channel outcomes with **Needs check** for unconfirmed publishes, **Publish now**, **Retry failed channels**, **Delete** |
| Compose | `channel.list`, `upload.*`, `post.create` | Caption, channel multi-select, **photos and videos from the library** (uploaded straight to S3 with presigned multipart), save as draft or schedule |
| Channels | `channel.list` | Grouped by platform, avatar with initials fallback, **Reconnect** badge from `insightsHealth`, Paused badge |
| Account | `user.me` | **Workspace switcher** (every tab reloads for the chosen workspace), sign out |

Sign-in is email + password (the NextAuth *credentials* provider). Google
sign-in is not wired — see *Not in v1.0* below for exactly what it needs.

## How auth works

`Sources/Core/AuthService.swift` mirrors the web login form exactly:

1. `GET /api/auth/csrf` → `{ csrfToken }` (+ `__Host-authjs.csrf-token` cookie)
2. `POST /api/auth/callback/credentials` (form: `csrfToken, email, password,
   loginType=email, json=true`) → `__Secure-authjs.session-token` cookie on success;
   a failed login comes back as `{ url: ".../login?error=CredentialsSignin" }`.

The cookie lives in the shared `HTTPCookieStorage`, which `TRPCClient` reuses, so
every tRPC call is authenticated and the session survives relaunch. `user.me` is
called on launch to validate it; any `UNAUTHORIZED` from tRPC clears the cookie
and returns to the login screen. Auth.js answers **HTTP 200 for a failed login**
when `json=true`, so `parseCallbackOutcome` only reports success once the session
cookie has actually landed (pure, unit-tested).

## Workspaces

`SessionStore.activeOrganizationId` is the single source of truth for the
`x-organization-id` header. On sign-in it is resolved by
`OrganizationSelection.resolve(stored:memberships:)`: the workspace the user
last chose on this device (UserDefaults, keyed per user id) when it is still one
of their memberships, else `memberships[0]` — the server's own OWNER-first /
oldest-first default. Switching on the Account tab re-pins the header, persists
the choice and refreshes the unread count; every tab reloads through the
`.task(id: session.activeOrganizationId)` pattern, so switching *tabs* never
refetches but switching *workspaces* always does.

## Media uploads

`Sources/Core/UploadService.swift` is a Swift port of the web's
`apps/web/lib/upload-multipart.ts`: `upload.initiate` → one presigned PUT per
8 MiB part (`upload.signPart`, a **fresh URL per attempt**, up to 6 attempts with
capped backoff, 3 parts in flight, HTTP 507 = storage full = terminal) →
`upload.complete` with the part ETags (quotes stripped) → a `Media` row. Part PUTs
go through a separate ephemeral `URLSession` that **never sends cookies**, so the
NextAuth session token cannot ride along to MinIO/S3. A cancelled upload is
aborted server-side. The client applies the server's own allow-list and caps
(JPEG/PNG/GIF/WebP/AVIF ≤ 50 MB; MP4/MOV/WebM/M4V ≤ 4 GB) before any network call.

Compose (`Sources/Features/Compose/MediaAttachments.swift`): photos and videos
come from `PhotosPicker`; HEIC photos are re-encoded as JPEG (the server does not
accept HEIC), videos are copied out of the picker as files and never loaded into
memory as a whole; uploads start the moment an item is picked; the post cannot
be submitted while anything is still uploading or failed. Either up to 10 photos
or exactly one video per post (the Instagram carousel rule). A video tile never
becomes an `Image` — a documented memory-kill on WebKit/iOS.

## Notifications

In-app only. The worker already writes a `Notification` row per publish outcome
(`post.published` / `post.failed`, link `/dashboard/posts/<id>`), approvals and
caption/super-text degradations; the app lists them, marks them read and deep
links a publish notification to the post. The unread count refreshes on launch,
on sign-in, on workspace switch, whenever the app returns to the foreground and
after any read. Push delivery is a separate project — see below.

## tRPC wire format

`Sources/Core/TRPCClient.swift` — the API uses the `superjson` transformer:

- query: `GET /api/trpc/<proc>?input={"json":{...}}`
- mutation: `POST /api/trpc/<proc>` with body `{"json":{...}}`
- success: `{"result":{"data":{"json":<value>}}}`
- error: `{"error":{"json":{"message","code","data":{"code","httpStatus","path"}}}}`

Dates arrive as ISO-8601 strings (usually with milliseconds). Prisma `Json`
columns (`metadata`, `contentVariants`) and `BigInt` columns (`Media.fileSize`)
are deliberately not modelled; `Decodable` ignores undeclared keys, so additive
server changes never break an installed build. `Platform` and notification
`type` are String wrappers, not enums, for the same reason.

## Build & test (no Xcode GUI needed)

```bash
cd apps/ios/PostAutomation

# Regenerate the .xcodeproj after editing project.yml or adding files
xcodegen generate              # brew install xcodegen

scripts/build-simulator.sh     # simulator build, no signing (SIMULATOR="iPhone 17" by default)
scripts/test.sh                # unit tests (wire format, auth parsing, upload planner,
                               # workspace selection, notifications) + UI tests
```

The scripts wrap the same `xcodebuild` invocations as before:

```bash
xcodebuild -project PostAutomation.xcodeproj -scheme PostAutomation \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath build build CODE_SIGNING_ALLOWED=NO
xcodebuild test -project PostAutomation.xcodeproj -scheme PostAutomation \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO
```

`UITests/LoginUITests.swift` performs one deliberately-failed sign-in against
production per run (fake `example.invalid` credentials) to prove the whole auth
path end to end. It never uses real credentials, and it is **not** something to
put in CI.

A machine with no iOS runtime installed needs `xcodebuild -downloadPlatform iOS`
first (several GB).

## Ship to TestFlight / the App Store

Everything the store needs is in the repo: the asset catalog (`AppIcon` single
1024×1024, `AccentColor`, `LaunchBackground`), `Sources/PrivacyInfo.xcprivacy`
(no tracking; declares the UserDefaults and file-attribute APIs the app uses),
`ITSAppUsesNonExemptEncryption = NO`, and version `1.0.0` build `2`
(`MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` in `project.yml`).

```bash
# Once, on the Mac: sign in to Xcode with the Apple Developer account that owns
# the Team, and register the bundle id co.in.postautomation.ios + an App Store
# Connect app record for it.
DEVELOPMENT_TEAM=XXXXXXXXXX scripts/archive.sh          # → build/export/PostAutomation.ipa
# then upload with the Transporter app, or:
#   xcrun altool --upload-app -f build/export/PostAutomation.ipa -t ios \
#     --apiKey <key id> --apiIssuer <issuer id>
EXPORT_METHOD=ad-hoc DEVELOPMENT_TEAM=XXXXXXXXXX scripts/archive.sh   # device builds for testers
```

The Team ID is on https://developer.apple.com/account → Membership. Bump
`CURRENT_PROJECT_VERSION` for every upload (App Store Connect rejects a reused
build number) and `MARKETING_VERSION` for every release.

## Not in v1.0 — and exactly what each needs

- **Google sign-in.** Google blocks OAuth inside embedded web views, and
  `ASWebAuthenticationSession` cannot hand its cookies to the app, so this needs
  **two small backend routes** — it is the one feature that cannot be built
  app-side only. Design: the app opens
  `https://postautomation.co.in/login?callbackUrl=/api/auth/mobile/finish` in
  `ASWebAuthenticationSession` (the user signs in with Google on the real site, so
  **no new Google Cloud redirect URI is needed**); `/api/auth/mobile/finish`
  (session-authenticated) mints a one-time, 60-second code bound to a PKCE
  verifier the app generated and redirects to `postautomation://auth?code=…`;
  the app `POST`s the code + verifier to `/api/auth/mobile/exchange`, which
  encodes a NextAuth session JWT and returns it as the normal
  `__Secure-authjs.session-token` `Set-Cookie`, after which everything works as
  it does after a password login. App side: the `postautomation` URL scheme in
  `Info.plist` and a "Continue with Google" button on `LoginView`. Until then a
  Google-only user sets a password on the web first (the login screen says so).
- **Push notifications (APNs).** Needs an APNs auth key (`.p8`) from the Apple
  Developer account, the `aps-environment` entitlement (a paid Team), a
  `device.register` procedure + table for device tokens, and the worker sending
  an HTTP/2 APNs request next to the `Notification` row it already writes. The
  in-app Notifications screen already shows the same content.
- **Org creation, team management, Insights, the comments inbox, Content Studio
  AI tools** stay web-only.

## Gotchas

- **Base URL must be `.co.in`** (`Sources/Core/APIConfig.swift`).
  `postautomation.in` 301-redirects, and the session cookie is scoped to the
  canonical host — pointing at `.in` drops the cookie and every call 401s.
- **Never hand-edit `PostAutomation.xcodeproj`** — it is generated from
  `project.yml` by `xcodegen generate`. Adding a source file needs no spec edit
  (the target globs `Sources/`), but regenerate so the committed project knows
  the file. `xcodegen` also regenerates `Sources/Info.plist` from
  `info.properties`, so every plist key must live in `project.yml` too.
- `--reset-session` launch argument clears cookies at startup so UI tests always
  begin signed out regardless of a persisted session from manual use.
