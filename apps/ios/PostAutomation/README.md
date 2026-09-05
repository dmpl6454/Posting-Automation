# PostAutomation iOS

Native SwiftUI companion app for the PostAutomation platform. Talks to the
**live** tRPC API at `https://postautomation.co.in` using the same NextAuth
session cookie the web app uses — **no backend changes were required**.

## What it does (v0.1)

| Tab | Backed by | Notes |
|---|---|---|
| Home | `analytics.dashboardStats` | Four lifetime stat cards + cumulative sparklines |
| Posts | `post.list` | Status filter chips, cursor pagination, per-channel outcomes + "Open post" links |
| Compose | `channel.list`, `post.create` | Caption, channel multi-select, save as draft or schedule |
| Channels | `channel.list` | Grouped by platform, avatar w/ initials fallback, **Reconnect** badge from `insightsHealth` |
| Account | `user.me` | Workspaces (memberships), sign out |

Sign-in is email + password (the NextAuth *credentials* provider). Google sign-in
is not wired yet — a Google-only user must set a password from the web dashboard.

## How auth works

`Sources/Core/AuthService.swift` mirrors the web login form exactly:

1. `GET /api/auth/csrf` → `{ csrfToken }` (+ `__Host-authjs.csrf-token` cookie)
2. `POST /api/auth/callback/credentials` (form: `csrfToken, email, password,
   loginType=email, json=true`) → `__Secure-authjs.session-token` cookie on success;
   a failed login comes back as `{ url: ".../login?error=CredentialsSignin" }`.

The cookie lives in the shared `HTTPCookieStorage`, which `TRPCClient` reuses, so
every tRPC call is authenticated and the session survives relaunch. `user.me` is
called on launch to validate it; any `UNAUTHORIZED` from tRPC clears the cookie
and returns to the login screen.

## tRPC wire format

`Sources/Core/TRPCClient.swift` — the API uses the `superjson` transformer:

- query: `GET /api/trpc/<proc>?input={"json":{...}}`
- mutation: `POST /api/trpc/<proc>` with body `{"json":{...}}`
- success: `{"result":{"data":{"json":<value>}}}`
- error: `{"error":{"json":{"message","code","data":{"code","httpStatus","path"}}}}`

Dates arrive as ISO-8601 strings (usually with milliseconds). Prisma `Json` and
`BigInt` columns are deliberately not modelled. `x-organization-id` is sent from
`user.me.memberships[0]` so the org is always explicit.

## Build & test (no Xcode GUI needed)

```bash
cd apps/ios/PostAutomation

# Regenerate the .xcodeproj after editing project.yml or adding files
xcodegen generate

# Build for the simulator (no signing)
xcodebuild -project PostAutomation.xcodeproj -scheme PostAutomation \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath build build CODE_SIGNING_ALLOWED=NO

# Unit tests (wire-format decoding, auth response parsing) + UI tests
xcodebuild test -project PostAutomation.xcodeproj -scheme PostAutomation \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO

# Install + launch on a booted simulator
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/PostAutomation.app
xcrun simctl launch booted co.in.postautomation.ios
```

`UITests/LoginUITests.swift` performs one deliberately-failed sign-in against
production per run (fake `example.invalid` credentials) to prove the whole
auth path end to end. It never uses real credentials.

## Not yet

- Google sign-in (needs `ASWebAuthenticationSession` + a mobile redirect URI)
- Media attachments in Compose (needs the presigned-multipart upload flow)
- Org switcher (the data is already loaded on the Account tab)
- Push notifications for publish results
