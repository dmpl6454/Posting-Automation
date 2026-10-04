/**
 * WordPressProvider ARTICLE path (2026-10-04): `metadata.wordpressArticle`
 * turns a self-hosted publish into a real blog post — title, excerpt, status,
 * per-site categories/tags, created tag names, Markdown body, every image
 * uploaded (first = featured, rest = figures). Absent, the legacy caption path
 * is untouched (wordpress-user-host.test.ts asserts its exact body).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const userHostFetch = vi.fn(async (..._a: any[]): Promise<Response> => new Response("{}"));
vi.mock("../utils/user-host-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/user-host-fetch")>();
  return { ...actual, userHostFetch: (...a: any[]) => userHostFetch(...a) };
});
const globalFetch = vi.fn(async (..._a: any[]): Promise<Response> => new Response("IMG", { headers: { "content-type": "image/png" } }));
vi.stubGlobal("fetch", (...a: any[]) => globalFetch(...a));

import { WordPressProvider } from "../providers/wordpress.provider";
import { readWordPressArticle, imageFiguresHtml } from "../utils/wordpress-article";
import { isAmbiguousPublishError } from "../utils/ambiguous-publish";

const SITE = "https://blog.example.com";
const tokens = { accessToken: "YWRtaW46cHc=", metadata: { kind: "self-hosted", siteUrl: SITE } } as any;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const p = new WordPressProvider();

const article = {
  title: "  Afratafri at Shivajipark  ",
  excerpt: "Fans swarm the premiere.",
  status: "draft",
  newTags: ["Premiere", " Bollywood ", "Premiere"],
  taxonomyBySite: { [SITE]: { categoryIds: [3, 3, 7], tagIds: [11] }, "https://other.site": { categoryIds: [99], tagIds: [] } },
};

beforeEach(() => {
  userHostFetch.mockReset();
  globalFetch.mockClear();
});

const calls = () => userHostFetch.mock.calls.map(([url, init]: any) => ({ url, method: init?.method ?? "GET", body: init?.body }));

describe("readWordPressArticle", () => {
  it("normalises a stored block and returns null for anything unusable", () => {
    expect(readWordPressArticle({ wordpressArticle: article })).toEqual({
      title: "Afratafri at Shivajipark",
      excerpt: "Fans swarm the premiere.",
      status: "draft",
      newTags: ["Premiere", "Bollywood"],
      taxonomyBySite: { [SITE]: { categoryIds: [3, 7], tagIds: [11] }, "https://other.site": { categoryIds: [99], tagIds: [] } },
    });
    expect(readWordPressArticle(undefined)).toBeNull();
    expect(readWordPressArticle({})).toBeNull();
    expect(readWordPressArticle({ wordpressArticle: "x" })).toBeNull();
    expect(readWordPressArticle({ wordpressArticle: { title: "  " } })).toBeNull();
    // Unknown status falls back to publish; non-integer ids are dropped.
    expect(readWordPressArticle({ wordpressArticle: { title: "t", status: "weird", taxonomyBySite: { a: { categoryIds: [1.5, "2"] } } } })).toEqual({
      title: "t",
      excerpt: undefined,
      status: "publish",
      newTags: [],
      taxonomyBySite: { a: { categoryIds: [], tagIds: [] } },
    });
  });

  it("imageFiguresHtml only embeds http(s) URLs and escapes them", () => {
    expect(imageFiguresHtml(['https://h/a"b.jpg', "javascript:alert(1)"])).toBe(
      '<figure class="wp-block-image"><img src="https://h/a&quot;b.jpg" alt=""></figure>',
    );
    expect(imageFiguresHtml([])).toBe("");
  });
});

describe("WordPressProvider self-hosted ARTICLE publish", () => {
  it("uploads every image, creates/reuses tags, then posts the rendered article (this site's terms only)", async () => {
    userHostFetch
      .mockResolvedValueOnce(json(201, { id: 101, source_url: `${SITE}/wp-content/uploads/a.png` })) // media 1 → featured
      .mockResolvedValueOnce(json(201, { id: 102, source_url: `${SITE}/wp-content/uploads/b.png` })) // media 2 → figure
      .mockResolvedValueOnce(json(201, { id: 55 })) // tag Premiere created
      .mockResolvedValueOnce(json(400, { code: "term_exists", data: { term_id: 11, status: 400 } })) // Bollywood exists (= id 11, already selected)
      .mockResolvedValueOnce(json(201, { id: 900, link: `${SITE}/?p=900`, slug: "afratafri", status: "draft" }));

    const r = await p.publishPost(tokens, {
      content: "# Intro\n\nFans **swarmed** the venue.",
      mediaUrls: [`https://cdn/a.png`, `https://cdn/b.png`],
      mediaTypes: ["image/png", "image/png"],
      metadata: { wordpressArticle: article },
    } as any);

    expect(r).toMatchObject({ platformPostId: "900", url: `${SITE}/?p=900`, metadata: { article: true, status: "draft" } });
    const c = calls();
    expect(c.map((x) => x.url)).toEqual([
      `${SITE}/wp-json/wp/v2/media`,
      `${SITE}/wp-json/wp/v2/media`,
      `${SITE}/wp-json/wp/v2/tags`,
      `${SITE}/wp-json/wp/v2/tags`,
      `${SITE}/wp-json/wp/v2/posts`,
    ]);
    expect(JSON.parse(c[2]!.body)).toEqual({ name: "Premiere" });
    expect(JSON.parse(c[4]!.body)).toEqual({
      title: "Afratafri at Shivajipark",
      content:
        "<h1>Intro</h1>\n<p>Fans <strong>swarmed</strong> the venue.</p>\n" +
        `<figure class="wp-block-image"><img src="${SITE}/wp-content/uploads/b.png" alt=""></figure>`,
      status: "draft",
      excerpt: "Fans swarm the premiere.",
      categories: [3, 7], // NOT the other site's [99]
      tags: [11, 55],
      featured_media: 101,
    });
  });

  it("a tag that cannot be created is dropped, never fails the publish; non-image media is skipped", async () => {
    userHostFetch
      .mockResolvedValueOnce(json(500, { message: "boom" })) // tag create fails
      .mockResolvedValueOnce(json(201, { id: 1, link: "l" }));
    const r = await p.publishPost(tokens, {
      content: "body",
      mediaUrls: ["https://cdn/clip.mp4"],
      mediaTypes: ["video/mp4"],
      metadata: { wordpressArticle: { title: "T", status: "publish", newTags: ["x"], taxonomyBySite: {} } },
    } as any);
    expect(r.platformPostId).toBe("1");
    expect(JSON.parse(calls()[1]!.body)).toEqual({ title: "T", content: "<p>body</p>", status: "publish" });
    expect(globalFetch).not.toHaveBeenCalled(); // the video was never downloaded
  });

  it("renders the body as TEXT — an HTML payload in the Markdown never reaches the site as markup", async () => {
    userHostFetch.mockResolvedValueOnce(json(201, { id: 2, link: "l" }));
    await p.publishPost(tokens, {
      content: '<script>alert(1)</script> [x](javascript:alert(1))',
      metadata: { wordpressArticle: { title: "T", status: "publish" } },
    } as any);
    const body = JSON.parse(calls()[0]!.body);
    expect(body.content).not.toContain("<script");
    expect(body.content).not.toContain("<a ");
    expect(body.content).toContain("&lt;script&gt;");
  });

  it("a 2xx without an id is an UNKNOWN outcome (Needs check), exactly like the legacy path", async () => {
    userHostFetch.mockResolvedValueOnce(new Response("<html>ok</html>", { status: 200 }));
    let err: any;
    try {
      await p.publishPost(tokens, { content: "b", metadata: { wordpressArticle: { title: "T", status: "publish" } } } as any);
    } catch (e) {
      err = e;
    }
    expect(isAmbiguousPublishError(err)).toBe(true);
  });

  it("without the marker the legacy caption path runs (title = first line, media = featured only)", async () => {
    userHostFetch.mockResolvedValueOnce(json(201, { id: 9 })).mockResolvedValueOnce(json(201, { id: 42, link: "l" }));
    await p.publishPost(tokens, { content: "Hello\nworld", mediaUrls: ["https://cdn/a.png"], metadata: { format: "FEED" } } as any);
    expect(JSON.parse(calls()[1]!.body)).toEqual({ title: "Hello", content: "Hello\nworld", status: "publish", featured_media: 9 });
  });
});
