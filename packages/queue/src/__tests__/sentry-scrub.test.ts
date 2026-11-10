import { describe, it, expect } from "vitest";
import { scrubString, scrubValue, scrubSentryEvent, sentrySampleRate, FILTERED } from "../sentry-scrub";

/**
 * Nothing secret may reach Sentry (2026-11-10). Every input below is the shape
 * a real error in this codebase takes.
 */
describe("scrubString", () => {
  it("removes a Graph access_token from a URL but keeps the URL readable", () => {
    const s = scrubString("GET https://graph.facebook.com/v18.0/123_456?fields=id&access_token=EAAGm0PX4ZCpsBAKZA1234567890abcdef failed");
    expect(s).not.toContain("EAAGm0PX4ZCps");
    expect(s).toContain("graph.facebook.com/v18.0/123_456?fields=id&access_token=[Filtered]");
  });

  it("keeps Meta's error code and subcode — they are the useful part", () => {
    const body = '{"error":{"message":"Session has been invalidated","code":190,"error_subcode":460,"fbtrace_id":"Axyz"}}';
    expect(scrubString(body)).toBe(body);
    expect(scrubString("Instagram error_subcode=2207073 code: 100")).toBe("Instagram error_subcode=2207073 code: 100");
  });

  it("filters an OAuth code and state only in query strings", () => {
    expect(scrubString("/api/oauth/callback/facebook?code=AQBx9-secret&state=signed.blob")).toBe(
      "/api/oauth/callback/facebook?code=[Filtered]&state=[Filtered]"
    );
  });

  it("filters JSON-style and header-style secrets", () => {
    expect(scrubString('{"client_secret":"abc123def","x":1}')).toBe('{"client_secret":"[Filtered]","x":1}');
    expect(scrubString("Authorization: Bearer ya29.a0AfH6SMBlongtokenvalue")).toBe("Authorization: Bearer [Filtered]");
    expect(scrubString("Authorization: OAuth EAAB1234567890abcdefghij")).toContain("OAuth [Filtered]");
  });

  it("filters well-known key shapes wherever they appear", () => {
    expect(scrubString("key sk-ant-api03-abcdefghijklmnop1234 leaked")).toBe(`key ${FILTERED} leaked`);
    expect(scrubString("stored enc:v1:abcd1234:efgh5678")).toBe(`stored ${FILTERED}`);
  });

  it("does not touch ordinary text", () => {
    const t = "Instagram media processing timed out after 240 seconds (token count 5)";
    expect(scrubString(t)).toBe(t);
  });
});

describe("scrubValue / scrubSentryEvent", () => {
  it("blanks secret-named keys at any depth (e.g. a Prisma argument echo)", () => {
    const v = scrubValue({ data: { channel: { accessToken: "EAAsecret", refreshToken: "r", name: "Bollywood" } } });
    expect(v).toEqual({ data: { channel: { accessToken: FILTERED, refreshToken: FILTERED, name: "Bollywood" } } });
  });

  it("drops cookies, headers and request bodies; keeps only the user id", () => {
    const e = scrubSentryEvent({
      message: "x",
      request: { url: "/api/trpc/post.create", cookies: { a: "b" }, headers: { cookie: "s" }, data: "caption", query_string: "access_token=EAAxyz123456" },
      user: { id: "u1", email: "a@b.c", ip_address: "1.2.3.4" },
    });
    expect(e.request).toEqual({ url: "/api/trpc/post.create", query_string: "access_token=[Filtered]" });
    expect(e.user).toEqual({ id: "u1" });
  });

  it("survives cycles and does not mutate its input", () => {
    const a: any = { msg: "access_token=EAAabcdefghij123456" };
    a.self = a;
    const out: any = scrubValue(a);
    expect(out.msg).toBe("access_token=[Filtered]");
    expect(out.self).toBe("[Circular]");
    expect(a.msg).toBe("access_token=EAAabcdefghij123456");
  });
});

describe("sentrySampleRate", () => {
  it("accepts 0..1 and falls back on anything else", () => {
    expect(sentrySampleRate("0.25", 0.1)).toBe(0.25);
    expect(sentrySampleRate("", 0.1)).toBe(0.1);
    expect(sentrySampleRate(undefined, 0.1)).toBe(0.1);
    expect(sentrySampleRate("2", 0.1)).toBe(0.1);
    expect(sentrySampleRate("abc", 0.1)).toBe(0.1);
  });
});
