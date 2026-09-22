import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  MCP_SCOPES,
  ALL_MCP_SCOPES,
  expandScopes,
  hasScope,
  sanitizeScopes,
  parseScopeParam,
  hashSecret,
  generateSecret,
  safeCompareHex,
  verifyPkce,
  canonicalizeResource,
  audienceMatches,
  isValidRedirectUri,
  redirectUriAllowed,
  buildUnauthorizedChallenge,
  buildInsufficientScopeChallenge,
} from "../lib/mcp-oauth";

/**
 * The OAuth core for the MCP connector. These are the checks that stand between
 * an external AI client and a platform that publishes to ~95 live audience
 * Pages, so the tests are written adversarially rather than as happy paths.
 */

describe("scope hierarchy", () => {
  it("a broader scope implies the narrower ones", () => {
    // Required by the MCP spec: "Servers MUST account for scope hierarchies,
    // where a broader scope implies narrower ones."
    expect(hasScope([MCP_SCOPES.PUBLISH], MCP_SCOPES.READ)).toBe(true);
    expect(hasScope([MCP_SCOPES.PUBLISH], MCP_SCOPES.WRITE)).toBe(true);
    expect(hasScope([MCP_SCOPES.WRITE], MCP_SCOPES.READ)).toBe(true);
  });

  it("🔴 a narrower scope NEVER implies a broader one", () => {
    // The direction that matters: read must never be able to publish.
    expect(hasScope([MCP_SCOPES.READ], MCP_SCOPES.WRITE)).toBe(false);
    expect(hasScope([MCP_SCOPES.READ], MCP_SCOPES.PUBLISH)).toBe(false);
    expect(hasScope([MCP_SCOPES.WRITE], MCP_SCOPES.PUBLISH)).toBe(false);
  });

  it("an empty grant satisfies nothing", () => {
    for (const s of ALL_MCP_SCOPES) expect(hasScope([], s)).toBe(false);
  });

  it("expands transitively without duplicating", () => {
    expect([...expandScopes([MCP_SCOPES.PUBLISH])].sort()).toEqual(
      [MCP_SCOPES.PUBLISH, MCP_SCOPES.WRITE, MCP_SCOPES.READ].sort()
    );
  });
});

describe("sanitizeScopes", () => {
  it("drops anything we do not define — an unknown scope is never granted", () => {
    expect(sanitizeScopes(["mcp:read", "admin:everything", "mcp:publish"])).toEqual([
      MCP_SCOPES.READ,
      MCP_SCOPES.PUBLISH,
    ]);
  });

  it("dedupes and handles absent input", () => {
    expect(sanitizeScopes(["mcp:read", "mcp:read"])).toEqual([MCP_SCOPES.READ]);
    expect(sanitizeScopes(undefined)).toEqual([]);
    expect(sanitizeScopes([])).toEqual([]);
  });

  it("parseScopeParam splits on arbitrary whitespace", () => {
    expect(parseScopeParam("mcp:read   mcp:write\tmcp:publish")).toEqual([
      "mcp:read",
      "mcp:write",
      "mcp:publish",
    ]);
    expect(parseScopeParam(null)).toEqual([]);
    expect(parseScopeParam("")).toEqual([]);
  });
});

describe("secret handling", () => {
  it("hashes deterministically and is not reversible to the input", () => {
    const secret = generateSecret("mcp_at");
    expect(hashSecret(secret)).toBe(hashSecret(secret));
    expect(hashSecret(secret)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSecret(secret)).not.toContain(secret);
  });

  it("generates 256 bits of entropy with the requested prefix", () => {
    const s = generateSecret("mcp_rt");
    expect(s.startsWith("mcp_rt_")).toBe(true);
    // base64url of 32 bytes is 43 chars.
    expect(s.slice("mcp_rt_".length).length).toBe(43);
    expect(generateSecret("x")).not.toBe(generateSecret("x"));
  });

  it("safeCompareHex matches equal digests and rejects everything else", () => {
    const a = hashSecret("one");
    expect(safeCompareHex(a, a)).toBe(true);
    expect(safeCompareHex(a, hashSecret("two"))).toBe(false);
  });

  it("🔴 safeCompareHex never throws on malformed or mismatched input", () => {
    // CLAUDE.md records a real incident where a length check on a UTF-16 string
    // followed by a byte-wise timingSafeEqual let a crafted value throw out of a
    // route. Non-hex and wrong-length inputs must return false, not throw.
    const a = hashSecret("one");
    expect(() => safeCompareHex(a, "")).not.toThrow();
    expect(safeCompareHex(a, "")).toBe(false);
    expect(safeCompareHex(a, "zz")).toBe(false);
    expect(safeCompareHex(a, a.slice(0, 60))).toBe(false);
    expect(safeCompareHex("", "")).toBe(false);
    expect(safeCompareHex(a, "é".repeat(64))).toBe(false);
  });
});

describe("PKCE", () => {
  const verifier = "a".repeat(43);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

  it("accepts a correct S256 verifier", () => {
    expect(verifyPkce(verifier, challenge, "S256")).toBe(true);
  });

  it("rejects a wrong verifier", () => {
    expect(verifyPkce("b".repeat(43), challenge, "S256")).toBe(false);
  });

  it("🔴 REFUSES the `plain` method outright", () => {
    // OAuth 2.1 removes plain. These are public clients: accepting it would let
    // anyone who intercepts the authorization code redeem it.
    expect(verifyPkce(verifier, verifier, "plain")).toBe(false);
    expect(verifyPkce(verifier, challenge, "plain")).toBe(false);
    expect(verifyPkce(verifier, challenge, "")).toBe(false);
    expect(verifyPkce(verifier, challenge, "s256")).toBe(false); // case-sensitive
  });

  it("enforces the RFC 7636 verifier alphabet and length", () => {
    expect(verifyPkce("short", challenge, "S256")).toBe(false);
    expect(verifyPkce("a".repeat(129), challenge, "S256")).toBe(false);
    // A verifier containing a character outside the unreserved set is refused
    // even if it would otherwise hash correctly.
    const bad = "a".repeat(42) + "!";
    const badChallenge = crypto.createHash("sha256").update(bad).digest("base64url");
    expect(verifyPkce(bad, badChallenge, "S256")).toBe(false);
  });

  it("does not throw on a malformed stored challenge", () => {
    expect(() => verifyPkce(verifier, "", "S256")).not.toThrow();
    expect(verifyPkce(verifier, "", "S256")).toBe(false);
  });
});

describe("resource / audience (RFC 8707)", () => {
  it("canonicalises scheme, host and trailing slash", () => {
    expect(canonicalizeResource("HTTPS://MCP.Example.COM")).toBe("https://mcp.example.com");
    expect(canonicalizeResource("https://mcp.example.com/")).toBe("https://mcp.example.com");
    expect(canonicalizeResource("https://mcp.example.com/mcp")).toBe("https://mcp.example.com/mcp");
    expect(canonicalizeResource("https://mcp.example.com:8443")).toBe("https://mcp.example.com:8443");
  });

  it("rejects the spec's invalid forms", () => {
    expect(canonicalizeResource("mcp.example.com")).toBeNull(); // no scheme
    expect(canonicalizeResource("https://mcp.example.com#frag")).toBeNull(); // fragment
    expect(canonicalizeResource("")).toBeNull();
    expect(canonicalizeResource(null)).toBeNull();
    expect(canonicalizeResource("ftp://mcp.example.com")).toBeNull();
  });

  it("🔴 audience matches only the same resource", () => {
    // "MCP servers MUST only accept tokens that are valid for use with their own
    // resources" and "MUST NOT accept or transit any other tokens."
    expect(audienceMatches("https://a.example.com", "https://a.example.com")).toBe(true);
    expect(audienceMatches("https://a.example.com/", "HTTPS://A.EXAMPLE.COM")).toBe(true);
    expect(audienceMatches("https://a.example.com", "https://b.example.com")).toBe(false);
    // A token for a DIFFERENT path on the same host is a different resource.
    expect(audienceMatches("https://a.example.com/other", "https://a.example.com/mcp")).toBe(false);
    // A token whose audience we cannot parse is never accepted.
    expect(audienceMatches("not-a-uri", "https://a.example.com")).toBe(false);
    expect(audienceMatches("", "https://a.example.com")).toBe(false);
  });
});

describe("redirect URI validation", () => {
  it("allows https anywhere", () => {
    expect(isValidRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
  });

  it("allows http ONLY on loopback, which is how desktop clients receive callbacks", () => {
    expect(isValidRedirectUri("http://127.0.0.1:33418/callback")).toBe(true);
    expect(isValidRedirectUri("http://[::1]:5000/cb")).toBe(true);
  });

  it("🔴 refuses http on a named host — including localhost, which DNS can repoint", () => {
    expect(isValidRedirectUri("http://localhost:3000/cb")).toBe(false);
    expect(isValidRedirectUri("http://evil.example.com/cb")).toBe(false);
  });

  it("🔴 refuses dangerous schemes", () => {
    expect(isValidRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isValidRedirectUri("data:text/html,<script>")).toBe(false);
    expect(isValidRedirectUri("file:///etc/passwd")).toBe(false);
  });

  it("allows a native custom scheme", () => {
    expect(isValidRedirectUri("claude://oauth/callback")).toBe(true);
  });

  it("refuses a fragment and unparseable input", () => {
    expect(isValidRedirectUri("https://ok.example/cb#frag")).toBe(false);
    expect(isValidRedirectUri("not a url")).toBe(false);
    expect(isValidRedirectUri("")).toBe(false);
  });

  it("🔴 matching is EXACT — never a prefix match", () => {
    // A prefix match on "https://app.example/cb" accepts
    // "https://app.example/cb.evil.com/x" and hands over the auth code.
    const registered = ["https://app.example/cb"];
    expect(redirectUriAllowed("https://app.example/cb", registered)).toBe(true);
    expect(redirectUriAllowed("https://app.example/cb/extra", registered)).toBe(false);
    expect(redirectUriAllowed("https://app.example/cb.evil.com/x", registered)).toBe(false);
    expect(redirectUriAllowed("https://app.example/cb?x=1", registered)).toBe(false);
    expect(redirectUriAllowed("https://app.example", registered)).toBe(false);
  });
});

describe("WWW-Authenticate challenges", () => {
  it("the 401 points the client at Protected Resource Metadata", () => {
    // This header is how a client discovers which authorization server to use.
    const h = buildUnauthorizedChallenge("https://x.example/.well-known/oauth-protected-resource");
    expect(h).toBe('Bearer resource_metadata="https://x.example/.well-known/oauth-protected-resource"');
  });

  it("the 403 names every scope the operation needs, in one challenge", () => {
    const h = buildInsufficientScopeChallenge(
      "https://x.example/.well-known/oauth-protected-resource",
      ["mcp:write", "mcp:publish"],
      "Publishing requires consent"
    );
    expect(h).toContain('error="insufficient_scope"');
    expect(h).toContain('scope="mcp:write mcp:publish"');
    expect(h).toContain("resource_metadata=");
  });

  it("a quote in the description cannot break out of the header", () => {
    const h = buildInsufficientScopeChallenge("https://x.example/.well-known/x", ["mcp:read"], 'he said "no"');
    expect(h).not.toMatch(/error_description="he said "no""/);
    expect(h).toContain(`error_description="he said 'no'"`);
  });
});
