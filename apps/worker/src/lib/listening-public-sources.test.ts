import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bingArticleUrl,
  bingNewsMentions,
  bingNewsUrl,
  blueskyMentions,
  blueskyPostUrl,
  blueskySearchUrl,
  gdeltDate,
  gdeltMentions,
  gdeltQuery,
  gdeltUrl,
  gdeltWaitMs,
  hackerNewsMentions,
  hackerNewsUrl,
  htmlToText,
  keywordToHashtag,
  lemmyInstance,
  lemmyMentions,
  lemmySearchUrl,
  mastodonInstances,
  mastodonMentions,
  mastodonTagUrl,
} from "./listening-public-sources";

/**
 * Fixtures are REAL responses captured on 2026-10-05 (trimmed to two items),
 * except GDELT, which rate-limited the capture host — its sample follows the
 * documented DOC 2.0 artlist format.
 */
const D = join(__dirname, "__fixtures__/listening-public");
const json = (f: string) => JSON.parse(readFileSync(join(D, f), "utf8"));
const NOW = Date.parse("2026-10-05T18:20:00Z");

describe("htmlToText", () => {
  it("turns paragraphs and breaks into newlines and decodes entities", () => {
    expect(htmlToText("<p>a</p><p>b<br>c &amp; d &#x27;e&#x27; &#8217;</p>")).toBe("a\n\nb\nc & d 'e' ’");
    expect(htmlToText("first<p>second<p>third")).toBe("first\n\nsecond\n\nthird");
    expect(htmlToText('<a href="x">#tag</a>')).toBe("#tag");
    expect(htmlToText("&#0; &#xFFFFFFF; ok")).toBe("ok");
  });
});

describe("Hacker News", () => {
  it("asks for stories and comments of the last 2 days", () => {
    const u = new URL(hackerNewsUrl("acme phone", NOW));
    expect(u.searchParams.get("query")).toBe("acme phone");
    expect(u.searchParams.get("tags")).toBe("(story,comment)");
    expect(u.searchParams.get("numericFilters")).toBe(`created_at_i>${Math.floor((NOW - 2 * 86400000) / 1000)}`);
  });
  it("parses a comment (with its story) and a story", () => {
    const out = hackerNewsMentions(json("hackernews.json"));
    expect(out.map((m) => [m.source, m.platformPostId, (m.metadata as any).kind])).toEqual([
      ["HACKERNEWS", "hn:49968389", "comment"],
      ["HACKERNEWS", "hn:49968105", "story"],
    ]);
    expect(out[0]!.content.startsWith("From speaking with people who work for OpenAI, Meta, and xAI:\n\n1) They")).toBe(true);
    expect(out[0]!.metadata).toMatchObject({ parentUrl: "https://news.ycombinator.com/item?id=49965786" });
    expect(out[1]).toMatchObject({ sourceUrl: "https://news.ycombinator.com/item?id=49968105", engagements: 17, authorHandle: "brokensegue" });
    expect(out[1]!.mentionedAt.toISOString()).toBe("2026-10-05T17:53:35.000Z");
  });
});

describe("Bluesky", () => {
  it("search URL: latest, last 2 days, language", () => {
    const u = new URL(blueskySearchUrl("acme", "EN", NOW));
    expect(u.host).toBe("api.bsky.app");
    expect(u.searchParams.get("sort")).toBe("latest");
    expect(u.searchParams.get("lang")).toBe("en");
    expect(u.searchParams.get("since")).toBe(new Date(NOW - 2 * 86400000).toISOString());
  });
  it("builds the bsky.app post URL from the AT URI and handle", () => {
    expect(blueskyPostUrl("at://did:plc:x/app.bsky.feed.post/3abc", "me.bsky.social")).toBe("https://bsky.app/profile/me.bsky.social/post/3abc");
    expect(blueskyPostUrl("at://did:plc:x/app.bsky.feed.like/3abc", "me")).toBeNull();
  });
  it("parses posts", () => {
    const out = blueskyMentions(json("bluesky.json"));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      source: "BLUESKY",
      platformPostId: "at://did:plc:3fibociwu7jy4bbdjhmm4nop/app.bsky.feed.post/3mx5jje43ns2f",
      sourceUrl: "https://bsky.app/profile/mementomori4950.bsky.social/post/3mx5jje43ns2f",
      authorHandle: "@mementomori4950.bsky.social",
    });
  });
});

describe("Mastodon", () => {
  it("keywords become hashtags; instances are validated", () => {
    expect(keywordToHashtag("Acme Phone")).toBe("acmephone");
    expect(keywordToHashtag("#Pathaan")).toBe("pathaan");
    expect(keywordToHashtag("ब्रांड")).toBe("ब्रांड");
    expect(keywordToHashtag("a")).toBeNull();
    expect(mastodonInstances({})).toEqual(["mastodon.social"]);
    // compose passes an unset key as "" — that must mean the default, not "off"
    expect(mastodonInstances({ LISTENING_MASTODON_INSTANCES: "" })).toEqual(["mastodon.social"]);
    expect(mastodonInstances({ LISTENING_MASTODON_INSTANCES: "Mastodon.social, fosstodon.org, http://evil/x, , mstdn.in" })).toEqual([
      "mastodon.social",
      "fosstodon.org",
      "mstdn.in",
    ]);
    expect(mastodonTagUrl("mastodon.social", "acme")).toBe("https://mastodon.social/api/v1/timelines/tag/acme?limit=40");
  });
  it("parses public statuses, skips boosts, keeps the global URI as identity, no follower count as reach", () => {
    const fixture = json("mastodon.json");
    const out = mastodonMentions([...fixture, { ...fixture[0], uri: "x", reblog: { id: 1 } }], "mastodon.social", NOW);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({
      source: "MASTODON",
      platformPostId: "https://mastodon.social/users/Some_Emo_Chick/statuses/117389635183279225",
      sourceUrl: "https://mastodon.social/@Some_Emo_Chick/117389635183279225",
      reach: 0,
      metadata: { instance: "mastodon.social", followers: 10203 },
    });
    expect(out[0]!.content.startsWith("Oh well, model collapse it is then… #OpenAI #ChatGPT")).toBe(true);
    // Older than 2 days is dropped.
    expect(mastodonMentions(fixture, "mastodon.social", NOW + 3 * 86400000)).toEqual([]);
  });
});

describe("Lemmy", () => {
  it("instance from env, validated; search URL", () => {
    expect(lemmyInstance({})).toBe("lemmy.world");
    expect(lemmyInstance({ LISTENING_LEMMY_INSTANCE: "" })).toBe("lemmy.world");
    expect(lemmyInstance({ LISTENING_LEMMY_INSTANCE: "bad/host" })).toBeNull();
    expect(lemmySearchUrl("lemmy.world", "acme")).toBe("https://lemmy.world/api/v3/search?q=acme&type_=All&sort=New&limit=20");
  });
  it("posts and comments that name a keyword", () => {
    const out = lemmyMentions(json("lemmy.json"), ["openai"], NOW);
    const kinds = out.map((m) => (m.metadata as any).kind);
    expect(kinds).toContain("post");
    expect(kinds).toContain("comment");
    expect(out.find((m) => m.platformPostId === "https://lemmy.world/comment/26177983")).toMatchObject({
      source: "LEMMY",
      authorName: "!hackernews",
      metadata: { kind: "comment", parentTitle: 'OpenAI "rogue" agent activities found on Wikimedia projects' },
    });
    expect(lemmyMentions(json("lemmy.json"), ["zzzunrelated"], NOW)).toEqual([]);
  });
});

describe("Bing News", () => {
  it("URL and the article's own link from Bing's redirect", () => {
    const u = new URL(bingNewsUrl("acme phone", "en"));
    expect(u.searchParams.get("q")).toBe('"acme phone"');
    expect(u.searchParams.get("count")).toBe("30");
    expect(bingArticleUrl("http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2fx.com%2fa&amp;c=1")).toBe("https://x.com/a");
    expect(bingArticleUrl("not a url")).toBeNull();
  });
  it("parses items as NEWS with the publisher as author", () => {
    const out = bingNewsMentions(readFileSync(join(D, "bing-news.xml"), "utf8"));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      source: "NEWS",
      sourceUrl: "https://www.theverge.com/ai-artificial-intelligence/1004827/openai-sam-altman-vanity-fair-interview-pr",
      authorName: "The Verge",
      metadata: { feed: "bing" },
    });
    expect(out[0]!.mentionedAt.toISOString()).toBe("2026-10-05T09:55:00.000Z");
  });
});

describe("GDELT", () => {
  it("query: OR needs parentheses; keywords under 3 characters are dropped", () => {
    expect(gdeltQuery(["acme"])).toBe("acme");
    expect(gdeltQuery(["acme", "acme phone", "ab"])).toBe('(acme OR "acme phone")');
    expect(gdeltQuery(["ab"])).toBeNull();
    const u = new URL(gdeltUrl("acme"));
    expect(u.searchParams.get("mode")).toBe("artlist");
    expect(u.searchParams.get("timespan")).toBe("1d");
  });
  it("parses the documented artlist format", () => {
    const body = {
      articles: [
        { url: "https://example.in/news/acme", url_mobile: "", title: "Acme opens in Pune", seendate: "20261005T171500Z", socialimage: "", domain: "example.in", language: "English", sourcecountry: "India" },
        { url: "javascript:x", title: "bad" },
      ],
    };
    const out = gdeltMentions(body);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: "NEWS", authorName: "example.in", metadata: { feed: "gdelt", country: "India", language: "English" } });
    expect(gdeltDate("20261005T171500Z").toISOString()).toBe("2026-10-05T17:15:00.000Z");
  });
  it("spacing gate", () => {
    expect(gdeltWaitMs(1000, 400)).toBe(600);
    expect(gdeltWaitMs(1000, 2000)).toBe(0);
  });
});
