/**
 * How a Mastodon / self-hosted WordPress publish failure is reported.
 *
 * The rule (2026-08-18 duplicate-post incident, CLAUDE.md "DUPLICATE POSTS
 * after Retry"): a create whose outcome is UNKNOWN must never be retried
 * automatically — it is parked as "Needs check". A request that provably never
 * reached the server is safe to retry. A refusal that retrying cannot fix
 * fails at once with an actionable message.
 *
 * Three outcomes, chosen by phase:
 *   create → after the post was sent: AmbiguousPublishError; before: retryable
 *   media  → never ambiguous (no post exists yet): retryable or refused
 *   read   → profile/delete: plain errors, never ambiguous
 */
import { describe, it, expect } from "vitest";
import { UserHostError } from "../utils/user-host-fetch";
import { isAmbiguousPublishError } from "../utils/ambiguous-publish";
import { isPublishRefusedError } from "../utils/publish-refused";
import {
  MASTODON_SERVICE,
  WORDPRESS_SERVICE,
  userHostFailure,
  userHostStatusFailure,
  unconfirmedCreate,
  summarizeRemoteError,
} from "../utils/user-host-publish";

const sent = (code = "ECONNRESET") => new UserHostError("transport", { code, requestSent: true });
const notSent = (code = "ECONNREFUSED") => new UserHostError("transport", { code, requestSent: false });
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("userHostFailure — client errors", () => {
  it("a create that reached the server and then failed is UNCONFIRMED (parked, never retried)", () => {
    for (const svc of [MASTODON_SERVICE, WORDPRESS_SERVICE]) {
      for (const code of ["ECONNRESET", "ETIMEDOUT"]) {
        const e = userHostFailure(sent(code), svc, "create");
        expect(isAmbiguousPublishError(e)).toBe(true);
        expect(e.message).toMatch(/may already be live/);
        expect(e.message).toMatch(/It didn't publish/);
      }
    }
  });

  it("a create that never reached the server is retryable", () => {
    const e = userHostFailure(notSent("ECONNREFUSED"), MASTODON_SERVICE, "create");
    expect(isAmbiguousPublishError(e)).toBe(false);
    expect(isPublishRefusedError(e)).toBe(false);
    expect(e.message).toBe("Could not reach the Mastodon instance (the connection was refused). Nothing was sent.");
    expect(userHostFailure(notSent("ENOTFOUND"), WORDPRESS_SERVICE, "create").message).toBe(
      "Could not reach the WordPress site (its address could not be looked up). Nothing was sent.",
    );
  });

  it("media failures are never unconfirmed — no post exists before the create", () => {
    for (const err of [sent("ETIMEDOUT"), notSent(), new UserHostError("response_too_big", { requestSent: true })]) {
      const e = userHostFailure(err, MASTODON_SERVICE, "media");
      expect(isAmbiguousPublishError(e)).toBe(false);
      expect(isPublishRefusedError(e)).toBe(false);
      expect(e.message).toMatch(/^Mastodon media upload did not finish \(.+\)\. No post was created\.$/);
    }
  });

  it("a private or malformed address is refused for every phase", () => {
    for (const phase of ["create", "media", "read"] as const) {
      const b = userHostFailure(new UserHostError("blocked"), WORDPRESS_SERVICE, phase);
      expect(isPublishRefusedError(b)).toBe(true);
      expect((b as any).reason).toBe("unsafe_destination");
      expect(b.name).toBe("UnrecoverableError"); // how the worker and BullMQ recognise a final failure
      expect(b.message).toMatch(/private or internal network.*Nothing was sent/);
      expect(isPublishRefusedError(userHostFailure(new UserHostError("bad_url"), WORDPRESS_SERVICE, phase))).toBe(true);
    }
  });

  it("a redirect is refused — except 303 on a create, which says the request WAS handled", () => {
    const r = userHostFailure(new UserHostError("redirect", { status: 307, requestSent: true }), MASTODON_SERVICE, "create");
    expect(isPublishRefusedError(r)).toBe(true);
    expect((r as any).reason).toBe("redirect");
    expect(r.message).toMatch(/HTTP 307.*nothing was created/);
    const s = userHostFailure(new UserHostError("redirect", { status: 303, requestSent: true }), MASTODON_SERVICE, "create");
    expect(isAmbiguousPublishError(s)).toBe(true);
    const m = userHostFailure(new UserHostError("redirect", { status: 303, requestSent: true }), MASTODON_SERVICE, "media");
    expect(isPublishRefusedError(m)).toBe(true);
  });

  it("an unexpected (non-client) error on a create is treated as unconfirmed, never retried", () => {
    expect(isAmbiguousPublishError(userHostFailure(new TypeError("boom"), MASTODON_SERVICE, "create"))).toBe(true);
    expect(isAmbiguousPublishError(userHostFailure(new TypeError("boom"), MASTODON_SERVICE, "media"))).toBe(false);
  });

  it("read-phase failures are plain errors", () => {
    const e = userHostFailure(sent("ETIMEDOUT"), MASTODON_SERVICE, "read");
    expect(isAmbiguousPublishError(e)).toBe(false);
    expect(e.message).toBe("Could not reach the Mastodon instance (no answer in time).");
  });
});

describe("userHostStatusFailure — HTTP statuses", () => {
  it("401/403 refuse with a reconnect instruction (not retried, not reworded by the classifier)", async () => {
    const m = await userHostStatusFailure(json(401, { error: "The access token is invalid" }), MASTODON_SERVICE, "create");
    expect(isPublishRefusedError(m)).toBe(true);
    expect((m as any).reason).toBe("credentials");
    expect(m.message).toMatch(/Mastodon did not accept this channel's access token \(HTTP 401\).*reconnect/);
    const w = await userHostStatusFailure(json(403, { code: "rest_cannot_create" }), WORDPRESS_SERVICE, "media");
    expect(w.message).toMatch(/Application Password/);
  });

  it("429 is retryable in every phase — the server refused before doing anything", async () => {
    for (const phase of ["create", "media"] as const) {
      const e = await userHostStatusFailure(json(429, {}), MASTODON_SERVICE, phase);
      expect(isAmbiguousPublishError(e)).toBe(false);
      expect(isPublishRefusedError(e)).toBe(false);
      expect(e.message).toMatch(/HTTP 429\)\. Nothing was created\.$/);
    }
  });

  it("5xx on a create is unconfirmed; on a media upload it is retryable", async () => {
    const c = await userHostStatusFailure(json(502, "<html>bad gateway</html>"), WORDPRESS_SERVICE, "create");
    expect(isAmbiguousPublishError(c)).toBe(true);
    expect(c.message).toMatch(/returned HTTP 502 after the post was sent/);
    const m = await userHostStatusFailure(json(500, {}), WORDPRESS_SERVICE, "media");
    expect(isAmbiguousPublishError(m)).toBe(false);
    expect(m.message).toBe("WordPress media upload failed on the server (HTTP 500). No post was created.");
  });

  it("other 4xx refuse with a SHORT summary of the platform's own error, never the raw body", async () => {
    const e = await userHostStatusFailure(
      json(422, { error: "Validation failed: Text character limit of 500 exceeded", junk: "x".repeat(5000) }),
      MASTODON_SERVICE,
      "create",
    );
    expect(isPublishRefusedError(e)).toBe(true);
    expect((e as any).reason).toBe("rejected");
    expect(e.message).toBe("Mastodon rejected the post (HTTP 422): Validation failed: Text character limit of 500 exceeded");
    expect(e.message).not.toMatch(/junk|xxxx/);
  });
});

describe("message text", () => {
  it("never promises a retry — the same text is stored on the FINAL attempt", async () => {
    const msgs = [
      userHostFailure(notSent(), MASTODON_SERVICE, "create").message,
      userHostFailure(sent("ETIMEDOUT"), WORDPRESS_SERVICE, "media").message,
      (await userHostStatusFailure(json(429, {}), MASTODON_SERVICE, "create")).message,
      (await userHostStatusFailure(json(503, {}), WORDPRESS_SERVICE, "media")).message,
    ];
    for (const m of msgs) expect(m).not.toMatch(/retry/i);
  });
});

describe("unconfirmedCreate", () => {
  it("names where to look on each platform", () => {
    expect(unconfirmedCreate(MASTODON_SERVICE, "x").message).toMatch(/check your Mastodon profile/);
    expect(unconfirmedCreate(WORDPRESS_SERVICE, "x").message).toMatch(/check Posts \(including Drafts\) in WordPress/);
  });
});

describe("summarizeRemoteError", () => {
  it("picks the platform's error fields and strips markup and control characters", () => {
    expect(summarizeRemoteError({ code: "rest_invalid_param", message: "Invalid <b>status</b>.\n\u0007" })).toBe(
      "rest_invalid_param — Invalid status.",
    );
    expect(summarizeRemoteError("<html><body>Oops</body></html>")).toBe("Oops");
    expect(summarizeRemoteError(null)).toBe("no details");
    expect(summarizeRemoteError({ error: "y".repeat(500) }).length).toBeLessThanOrEqual(200);
  });
});
