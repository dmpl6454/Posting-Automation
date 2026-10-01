/**
 * Every error a Mastodon / self-hosted WordPress publish can throw, run through
 * the worker's REAL routing (2026-10-01, publish-time SSRF fix).
 *
 * Why this matters: classifyError() substring-matches messages, and its
 * token_expired and content_too_large branches call publishPost AGAIN. A
 * retryable message containing "401", "token"+"invalid", "too large" and so on
 * would therefore re-publish; one containing "rate limit"/"too many" would be
 * re-queued forever; "fetch failed"/"ETIMEDOUT" would be replayed in-job.
 * The texts live in packages/social; the classifier lives here — only a test
 * that imports both can keep them compatible.
 */
import { describe, it, expect } from "vitest";
import {
  MASTODON_SERVICE,
  WORDPRESS_SERVICE,
  DISCORD_SERVICE,
  userHostFailure,
  userHostStatusFailure,
  retryableMediaFailure,
  UserHostError,
} from "@postautomation/social";
import { classifyError, routePublishError } from "../lib/publish-recovery";

const services = [MASTODON_SERVICE, WORDPRESS_SERVICE, DISCORD_SERVICE];
const phases = ["create", "media", "read"] as const;
const codes = ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EPIPE"];

async function everyError(): Promise<Error[]> {
  const out: Error[] = [];
  for (const svc of services) {
    for (const phase of phases) {
      for (const code of codes) {
        for (const requestSent of [true, false]) {
          out.push(userHostFailure(new UserHostError("transport", { code, requestSent }), svc, phase));
        }
      }
      for (const kind of ["blocked", "bad_url", "response_too_big", "bad_status"] as const) {
        out.push(userHostFailure(new UserHostError(kind, { requestSent: true }), svc, phase));
      }
      for (const status of [301, 302, 303, 307, 308]) {
        out.push(userHostFailure(new UserHostError("redirect", { status, requestSent: true }), svc, phase));
      }
      out.push(userHostFailure(new TypeError("fetch failed"), svc, phase));
      for (const why of ["the attached file could not be read from storage", "the reply could not be read", "the instance was still processing it"]) {
        out.push(retryableMediaFailure(svc, why));
      }
      for (const status of [400, 401, 403, 404, 413, 422, 429, 500, 502, 503, 504]) {
        // A hostile body full of classifier keywords.
        const body = JSON.stringify({ error: "token invalid 401 403 permission rate limit too many too large fetch failed ETIMEDOUT" });
        out.push(await userHostStatusFailure(new Response(body, { status }), svc, phase));
      }
    }
  }
  return out;
}

describe("user-host publish errors vs the worker's routing", () => {
  it("retryable errors classify as plain 'unknown' and cannot trigger the in-job replay", async () => {
    const retryable = (await everyError()).filter((e) => routePublishError(e) === "classify");
    expect(retryable.length).toBeGreaterThan(20);
    for (const e of retryable) {
      expect(classifyError(e.message), e.message).toBe("unknown");
      // post-publish.worker.ts replays publishPost in-job on exactly these.
      expect(e.message).not.toBe("fetch failed");
      expect(e.message).not.toMatch(/ETIMEDOUT/);
    }
  });

  it("refusals route as final failures, and unconfirmed creates as ambiguous", async () => {
    const all = await everyError();
    const routes = new Set(all.map((e) => routePublishError(e)));
    expect(routes).toEqual(new Set(["classify", "terminal", "ambiguous"]));
    for (const e of all) {
      if ((e as { isPublishRefused?: boolean }).isPublishRefused) expect(routePublishError(e)).toBe("terminal");
      if ((e as { isAmbiguousPublish?: boolean }).isAmbiguousPublish) expect(routePublishError(e)).toBe("ambiguous");
    }
  });

  it("only create errors are ever ambiguous", async () => {
    for (const svc of services) {
      for (const phase of ["media", "read"] as const) {
        for (const requestSent of [true, false]) {
          const e = userHostFailure(new UserHostError("transport", { code: "ETIMEDOUT", requestSent }), svc, phase);
          expect(routePublishError(e)).not.toBe("ambiguous");
        }
      }
    }
  });
});
