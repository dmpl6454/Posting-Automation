import { describe, it, expect } from "vitest";
import {
  mentionDedupKey,
  normalizeUrl,
  linkedInPostUrl,
  chunkKeywords,
  orQuery,
  searchTerm,
  planMentionBatch,
  candidateIdentities,
  alertOnCooldown,
  ALERT_COOLDOWN_MS,
  hasExcludedWord,
  matchesAnyKeyword,
  cleanKeywords,
  DEDUP_KEY_MAX,
  chunk,
} from "./listening-sync-plan";

describe("mentionDedupKey — platform id, then permalink, then content", () => {
  it("prefers the platform post id over the url and the text", () => {
    const k = mentionDedupKey({ source: "TWITTER", platformPostId: "123", sourceUrl: "https://x.com/i/status/123", content: "a" });
    expect(k).toBe("TWITTER:id:123");
  });
  it("falls back to a normalised url: fragment and tracking params do not change identity", () => {
    const a = mentionDedupKey({ source: "NEWS", sourceUrl: "https://News.example/a?utm_source=x&id=1#top", content: "a" });
    const b = mentionDedupKey({ source: "NEWS", sourceUrl: "https://news.example/a?id=1", content: "b" });
    expect(a).toBe(b);
    expect(a).toBe("NEWS:url:https://news.example/a?id=1");
  });
  it("falls back to a content hash for a url-less mention, so LinkedIn posts finally dedupe", () => {
    const a = mentionDedupKey({ source: "LINKEDIN", sourceUrl: null, content: "Hello  World" });
    const b = mentionDedupKey({ source: "LINKEDIN", sourceUrl: null, content: "hello world " });
    expect(a).toBe(b);
    expect(a).toMatch(/^LINKEDIN:text:[0-9a-f]{40}$/);
  });
  it("hashes a key that would exceed the stored length", () => {
    const k = mentionDedupKey({ source: "NEWS", sourceUrl: `https://n.example/${"x".repeat(400)}`, content: "" });
    expect(k.length).toBeLessThanOrEqual(DEDUP_KEY_MAX);
    expect(k).toMatch(/^NEWS:h:[0-9a-f]{40}$/);
  });
  it("normalizeUrl leaves a non-URL string alone", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
  });
});

describe("linkedInPostUrl", () => {
  it("builds the feed permalink for share / ugcPost / activity URNs", () => {
    expect(linkedInPostUrl("urn:li:share:7000000000000000001")).toBe("https://www.linkedin.com/feed/update/urn:li:share:7000000000000000001/");
    expect(linkedInPostUrl("urn:li:ugcPost:1")).toContain("urn:li:ugcPost:1");
    expect(linkedInPostUrl("urn:li:activity:2")).toContain("urn:li:activity:2");
  });
  it("returns null for anything else rather than inventing a link", () => {
    expect(linkedInPostUrl("urn:li:organization:1")).toBeNull();
    expect(linkedInPostUrl("")).toBeNull();
    expect(linkedInPostUrl(undefined)).toBeNull();
  });
});

describe("keyword batching — one request per chunk, not per keyword", () => {
  it("cleanKeywords trims, drops empties and case-duplicates, keeps order", () => {
    expect(cleanKeywords([" Nike ", "", "nike", "Air  Max"])).toEqual(["Nike", "Air Max"]);
  });
  it("quotes phrases and operator-bearing terms, leaves single words bare", () => {
    expect(searchTerm("post automation")).toBe('"post automation"');
    expect(searchTerm("nike")).toBe("nike");
    expect(searchTerm('say "hi"')).toBe('"say hi"');
  });
  it("orQuery joins with OR", () => {
    expect(orQuery(["nike", "air max"])).toBe('nike OR "air max"');
    expect(orQuery(["nike"])).toBe("nike");
    expect(orQuery([])).toBe("");
  });
  it("respects maxPerChunk", () => {
    expect(chunkKeywords(["a", "b", "c", "d", "e", "f", "g"], { maxPerChunk: 3 })).toEqual([["a", "b", "c"], ["d", "e", "f"], ["g"]]);
  });
  it("respects maxChars and never splits a single oversized keyword", () => {
    const [a, b, c] = ["x".repeat(50), "y".repeat(50), "z".repeat(50)];
    const chunks = chunkKeywords([a, b, c], { maxPerChunk: 10, maxChars: 110 });
    expect(chunks).toEqual([[a, b], [c]]);
    expect(chunkKeywords(["y".repeat(500)], { maxChars: 100 })).toEqual([["y".repeat(500)]]);
  });
  it("an all-blank list yields no chunks (no empty request)", () => {
    expect(chunkKeywords(["", "  "])).toEqual([]);
  });
});

describe("filters", () => {
  it("hasExcludedWord / matchesAnyKeyword are case-insensitive substring checks", () => {
    expect(hasExcludedWord("Big SALE today", ["sale"])).toBe(true);
    expect(hasExcludedWord("Big SALE today", [])).toBe(false);
    expect(matchesAnyKeyword("Launching Air Max", ["air max"])).toBe(true);
    expect(matchesAnyKeyword("Launching", ["air max", " "])).toBe(false);
  });
});

describe("planMentionBatch — one pass decides what is new", () => {
  const raws = [
    { source: "TWITTER", platformPostId: "1", sourceUrl: "https://x.com/i/status/1", content: "nike drop" },
    { source: "TWITTER", platformPostId: "1", sourceUrl: "https://x.com/i/status/1", content: "nike drop" }, // same tweet via 2nd keyword
    { source: "LINKEDIN", sourceUrl: null, content: "Our nike story" },
    { source: "NEWS", sourceUrl: "https://n.example/old", content: "old article" }, // legacy row by url
    { source: "REDDIT", sourceUrl: "https://reddit.com/r/x/1", content: "nike scam alert" }, // excluded word
  ];
  it("drops excluded words, in-batch duplicates and already-stored rows, keeps the rest with keys", () => {
    const existingKeys = new Set([mentionDedupKey(raws[2]!)]);
    const existingUrls = new Set(["https://n.example/old"]);
    const plan = planMentionBatch(raws, { excludeWords: ["scam"], existingKeys, existingUrls });
    expect(plan.rows.map((r) => r.dedupKey)).toEqual(["TWITTER:id:1"]);
    expect(plan.skipped).toEqual({ excluded: 1, duplicateInBatch: 1, alreadyStored: 2 });
  });
  it("with nothing stored yet, every distinct mention is inserted", () => {
    const plan = planMentionBatch(raws, { excludeWords: [], existingKeys: new Set(), existingUrls: new Set() });
    expect(plan.rows).toHaveLength(4);
  });
  it("candidateIdentities lists each key and url once for the lookup query", () => {
    const ids = candidateIdentities(raws);
    expect(ids.keys).toHaveLength(4);
    expect(ids.urls).toEqual(["https://x.com/i/status/1", "https://n.example/old", "https://reddit.com/r/x/1"]);
  });
});

describe("alertOnCooldown", () => {
  const now = new Date("2026-10-04T12:00:00Z");
  it("no previous alert ⇒ not on cooldown", () => {
    expect(alertOnCooldown(null, now)).toBe(false);
  });
  it("an alert inside the window suppresses a repeat; one outside does not", () => {
    expect(alertOnCooldown(new Date(now.getTime() - ALERT_COOLDOWN_MS + 1), now)).toBe(true);
    expect(alertOnCooldown(new Date(now.getTime() - ALERT_COOLDOWN_MS), now)).toBe(false);
  });
});

describe("chunk", () => {
  it("splits evenly and keeps the tail", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});
