/**
 * URL Content Extractor
 * Fetches and extracts readable content from any URL (articles, social media, videos).
 */

export interface ExtractedContent {
  title: string;
  description: string;
  body: string;
  images: string[];
  url: string;
  siteName: string;
  type: "article" | "social" | "video" | "unknown";
  author?: string;
  publishedAt?: string;
}

const TIMEOUT_MS = 15_000;
const MAX_BODY_LENGTH = 15_000;

/** Decode HTML entities (named + numeric decimal + hex, incl. emoji) so raw
 *  `&quot;`/`&#x1f37f;`/`&#8217;` never reach the creative template. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ldquo: "“", rdquo: "”", lsquo: "'", rsquo: "'",
  hellip: "…", mdash: "—", ndash: "–", copy: "©", reg: "®", trade: "™",
};

/** Normalize Unicode typographic quotes / dashes to plain ASCII equivalents
 *  so decoded social-media text is safe for template rendering. */
const UNICODE_NORMALIZE: Record<number, string> = {
  0x2018: "'", 0x2019: "'", // ' ' left/right single quotation mark → apostrophe
  0x201c: "“", 0x201d: "”", // preserve " " as-is (already ASCII-safe)
};

export function decodeEntities(input: string): string {
  if (!input) return input;
  return input
    // hex: &#x1f37f;
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      try {
        const cp = parseInt(hex, 16);
        return UNICODE_NORMALIZE[cp] ?? String.fromCodePoint(cp);
      } catch { return _m; }
    })
    // decimal: &#8217;
    .replace(/&#(\d+);/g, (_m, dec) => {
      try {
        const cp = parseInt(dec, 10);
        return UNICODE_NORMALIZE[cp] ?? String.fromCodePoint(cp);
      } catch { return _m; }
    })
    // named: &amp; &quot; ...
    .replace(/&([a-zA-Z]+);/g, (_m, name) => NAMED_ENTITIES[name] ?? _m);
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Googlebot is whitelisted by most news/publisher sites for indexing
// — falling back to this UA bypasses many soft-blocks on data-center IPs.
const GOOGLEBOT_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

// Full set of browser-mimicking headers. Sending just User-Agent often
// trips anti-bot heuristics (Cloudflare/Akamai/Imperva). Adding Accept,
// Accept-Language, Sec-Fetch-* matches a real Chrome request and
// satisfies most "JS challenge" pages on the first hit.
function browserHeaders(referer?: string): Record<string, string> {
  return {
    "User-Agent": USER_AGENT,
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-Ch-Ua": '"Chromium";v="120", "Google Chrome";v="120", "Not?A_Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"macOS"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": referer ? "same-origin" : "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    ...(referer ? { Referer: referer } : {}),
  };
}

/**
 * Fetch a URL with progressive fallback strategies. Many news/publisher
 * sites block requests from data-center IPs with HTTP 403 even when
 * sent with a real Chrome UA — they need either Googlebot or a proxy
 * that fetches from a residential IP.
 *
 * Order of attempts:
 *   1. Full Chrome browser headers + Google referer
 *   2. Googlebot UA (whitelisted by most publishers for indexing)
 *   3. r.jina.ai reader proxy (free, fetches + converts to readable HTML)
 *   4. archive.org "newest" snapshot (only for hard 403 + small body)
 *
 * Returns the HTML body string and the effective URL (after any redirects).
 */
async function fetchHtmlWithFallback(
  url: string
): Promise<{ html: string; viaProxy: boolean }> {
  let lastErr: unknown;

  // ── Attempt 1: full Chrome headers with Google as referer ──────────
  try {
    const res = await fetch(url, {
      headers: browserHeaders("https://www.google.com/"),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
    if (res.ok) {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("text/html") || ct.includes("application/xhtml") || ct.includes("text/plain")) {
        return { html: await res.text(), viaProxy: false };
      }
    }
    lastErr = new Error(`HTTP ${res.status}`);
  } catch (e) {
    lastErr = e;
  }

  // ── Attempt 2: Googlebot UA ───────────────────────────────────────
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": GOOGLEBOT_UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
    if (res.ok) {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("text/html") || ct.includes("application/xhtml") || ct.includes("text/plain")) {
        return { html: await res.text(), viaProxy: false };
      }
    }
    lastErr = new Error(`Googlebot HTTP ${res.status}`);
  } catch (e) {
    lastErr = e;
  }

  // ── Attempt 3: r.jina.ai reader proxy ──────────────────────────────
  // Free service that fetches from residential IPs and returns clean
  // readable text. Returns markdown-ish output that still works with
  // our title/description extraction since we use og: tags too — and
  // for sites where they fail, the body extractor falls back to plain
  // text which is exactly what r.jina.ai returns.
  try {
    const proxyUrl = `https://r.jina.ai/${url}`;
    const res = await fetch(proxyUrl, {
      headers: {
        "Accept": "text/plain, text/html, */*",
        "X-Return-Format": "html",
      },
      signal: AbortSignal.timeout(30_000), // proxy may be slower
      redirect: "follow",
    });
    if (res.ok) {
      const body = await res.text();
      if (body && body.length > 200) {
        return { html: body, viaProxy: true };
      }
    }
    lastErr = new Error(`r.jina.ai HTTP ${res.status}`);
  } catch (e) {
    lastErr = e;
  }

  // All strategies exhausted
  throw new Error(
    `Failed to fetch URL: site is blocking requests (last error: ${(lastErr as Error)?.message || lastErr}). ` +
      `Try pasting the article text directly, or use a different source URL.`
  );
}

/** Detect URL type from hostname */
function detectUrlType(
  url: string
): "youtube" | "twitter" | "instagram" | "facebook" | "linkedin" | "tiktok" | "reddit" | "article" {
  const host = new URL(url).hostname.replace("www.", "").toLowerCase();
  if (host.includes("youtube.com") || host.includes("youtu.be")) return "youtube";
  if (host.includes("twitter.com") || host.includes("x.com")) return "twitter";
  if (host.includes("instagram.com")) return "instagram";
  if (host.includes("facebook.com") || host.includes("fb.com")) return "facebook";
  if (host.includes("linkedin.com")) return "linkedin";
  if (host.includes("tiktok.com")) return "tiktok";
  if (host.includes("reddit.com")) return "reddit";
  return "article";
}

/** Extract YouTube video ID */
function getYouTubeVideoId(url: string): string | null {
  const u = new URL(url);
  if (u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("/")[0] || null;
  return u.searchParams.get("v");
}

/** Minimal HTML tag stripper */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract meta tag content from raw HTML */
function getMeta(html: string, property: string): string {
  // Try og: / twitter: / name= patterns
  const patterns = [
    new RegExp(`<meta[^>]*property=["']${property}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']${property}["']`, "i"),
    new RegExp(`<meta[^>]*name=["']${property}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']${property}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1];
  }
  return "";
}

/** Extract title from HTML */
function getTitle(html: string): string {
  const og = getMeta(html, "og:title");
  if (og) return og;
  const tw = getMeta(html, "twitter:title");
  if (tw) return tw;
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1]?.trim() || "";
}

/** Extract main images from HTML */
function getImages(html: string): string[] {
  const images: string[] = [];
  const og = getMeta(html, "og:image");
  if (og) images.push(og);
  const tw = getMeta(html, "twitter:image");
  if (tw && !images.includes(tw)) images.push(tw);
  // Get first few article images
  const imgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
  let match;
  while ((match = imgRegex.exec(html)) !== null && images.length < 6) {
    const src = match[1]!;
    if (
      src.startsWith("http") &&
      !src.includes("icon") &&
      !src.includes("logo") &&
      !src.includes("avatar") &&
      !src.includes("pixel") &&
      !src.includes("1x1")
    ) {
      if (!images.includes(src)) images.push(src);
    }
  }
  return images;
}

/** Extract article body — find the largest text block */
function getArticleBody(html: string): string {
  // Try article or main tags first
  const articleMatch = html.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i);
  if (articleMatch?.[1]) {
    const text = stripHtml(articleMatch[1]);
    if (text.length > 200) return text.slice(0, MAX_BODY_LENGTH);
  }

  const mainMatch = html.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i);
  if (mainMatch?.[1]) {
    const text = stripHtml(mainMatch[1]);
    if (text.length > 200) return text.slice(0, MAX_BODY_LENGTH);
  }

  // Collect all paragraph text
  const paragraphs: string[] = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(html)) !== null) {
    const text = stripHtml(pMatch[1]!);
    if (text.length > 40) paragraphs.push(text);
  }

  if (paragraphs.length > 0) {
    return paragraphs.join("\n\n").slice(0, MAX_BODY_LENGTH);
  }

  // Fallback: strip everything
  return stripHtml(html).slice(0, MAX_BODY_LENGTH);
}

/** YouTube extraction via oEmbed + page meta */
async function extractYouTube(url: string): Promise<ExtractedContent> {
  const videoId = getYouTubeVideoId(url);

  // Use oEmbed for basic info
  let title = "";
  let author = "";
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) {
      const data = (await res.json()) as any;
      title = data.title || "";
      author = data.author_name || "";
    }
  } catch { /* fallback below */ }

  // Fetch page for description
  let description = "";
  let body = "";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      const html = await res.text();
      if (!title) title = getTitle(html);
      description = getMeta(html, "og:description") || getMeta(html, "description");
      body = description;
    }
  } catch { /* use what we have */ }

  const thumbnail = videoId
    ? `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`
    : "";

  return {
    title,
    description,
    body: body || description || title,
    images: thumbnail ? [thumbnail] : [],
    url,
    siteName: "YouTube",
    type: "video",
    author,
  };
}

/** Generic web page extraction with multi-stage anti-block fallback */
async function extractWebPage(url: string): Promise<ExtractedContent> {
  const { html, viaProxy } = await fetchHtmlWithFallback(url);

  if (viaProxy) {
    console.log(`[url-extractor] ${new URL(url).hostname} blocked direct fetch — extracted via r.jina.ai proxy`);
  }

  const title = getTitle(html);
  const description = getMeta(html, "og:description") || getMeta(html, "description");
  const siteName = getMeta(html, "og:site_name") || new URL(url).hostname;
  const images = getImages(html);
  const body = getArticleBody(html);
  const author = getMeta(html, "author") || getMeta(html, "article:author");
  const publishedAt = getMeta(html, "article:published_time") || getMeta(html, "datePublished");

  const urlType = detectUrlType(url);
  const type: ExtractedContent["type"] =
    urlType === "twitter" || urlType === "instagram" || urlType === "facebook" || urlType === "linkedin" || urlType === "tiktok"
      ? "social"
      : urlType === "reddit"
        ? "social"
        : "article";

  return {
    title,
    description,
    body: body || description || title,
    images,
    url,
    siteName,
    type,
    author,
    publishedAt,
  };
}

/** Instagram extraction via multiple methods */
async function extractInstagram(url: string): Promise<ExtractedContent> {
  let title = "";
  let description = "";
  let author = "";
  let images: string[] = [];
  let body = "";

  // Method 1: Use ddinstagram (public proxy that works without auth)
  const shortcode = url.match(/instagram\.com\/(?:p|reel|tv)\/([^/?]+)/)?.[1];
  if (shortcode) {
    try {
      const ddUrl = `https://www.ddinstagram.com/p/${shortcode}/`;
      const res = await fetch(ddUrl, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
      if (res.ok) {
        const html = await res.text();
        title = getMeta(html, "og:title") || getTitle(html);
        description = getMeta(html, "og:description") || getMeta(html, "description");
        const ogImage = getMeta(html, "og:image");
        if (ogImage) images.push(ogImage);
        body = description;
        // Extract author from title like "Author (@handle) on Instagram"
        const authorMatch = title?.match(/^(.+?)\s*\(/);
        if (authorMatch) author = authorMatch[1]!.trim();
      }
    } catch { /* try next method */ }
  }

  // Method 2: Try Instagram's embed endpoint
  if (!title || title === "Instagram") {
    try {
      const embedUrl = `https://api.instagram.com/oembed/?url=${encodeURIComponent(url)}`;
      const res = await fetch(embedUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data.title) title = data.title;
        if (data.author_name) author = data.author_name;
        if (data.thumbnail_url) images = [data.thumbnail_url, ...images.filter(i => i !== data.thumbnail_url)];
        // The HTML field contains the caption
        if (data.html) {
          const captionMatch = data.html.match(/class=".*?caption.*?"[^>]*>([\s\S]*?)<\/div>/i);
          if (captionMatch) body = stripHtml(captionMatch[1]);
        }
      }
    } catch { /* try next method */ }
  }

  // Method 3: Direct fetch with full browser headers
  if (!title || title === "Instagram") {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
      if (res.ok) {
        const html = await res.text();
        const ogTitle = getMeta(html, "og:title");
        if (ogTitle && ogTitle !== "Instagram") title = ogTitle;
        if (!description) description = getMeta(html, "og:description") || getMeta(html, "description");
        const ogImage = getMeta(html, "og:image");
        if (ogImage && !images.includes(ogImage)) images.push(ogImage);
        if (!body) body = description;
        if (!author) {
          const authorFromTitle = (ogTitle || "").match(/^(.+?)\s*(?:\(|on Instagram)/);
          if (authorFromTitle) author = authorFromTitle[1]!.trim();
        }
      }
    } catch { /* use what we have */ }
  }

  // Build final result
  if (!title || title === "Instagram") {
    const isReel = url.includes("/reel/");
    title = isReel ? "Instagram Reel" : "Instagram Post";
    if (author) title = `${author}'s ${isReel ? "Reel" : "Post"}`;
  }

  return {
    title,
    description: description || body || title,
    body: body || description || title,
    images,
    url,
    siteName: "Instagram",
    type: "social",
    author,
  };
}

/** Twitter/X extraction with better handling */
async function extractTwitter(url: string): Promise<ExtractedContent> {
  // Try to use nitter or fxtwitter for better extraction
  let title = "";
  let description = "";
  let author = "";
  let images: string[] = [];
  let body = "";

  // Try fxtwitter for better meta extraction
  const fxUrl = url.replace(/twitter\.com|x\.com/, "fxtwitter.com");
  try {
    const res = await fetch(fxUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
    if (res.ok) {
      const html = await res.text();
      title = getMeta(html, "og:title") || getTitle(html);
      description = getMeta(html, "og:description") || getMeta(html, "description");
      const ogImage = getMeta(html, "og:image");
      if (ogImage) images.push(ogImage);
      body = description;
      author = title.split("(@")?.[0]?.trim() || "";
    }
  } catch { /* fallback */ }

  // Fallback: try original URL
  if (!title) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
      if (res.ok) {
        const html = await res.text();
        title = getTitle(html) || "X Post";
        description = getMeta(html, "og:description") || getMeta(html, "description");
        const ogImage = getMeta(html, "og:image");
        if (ogImage && !images.includes(ogImage)) images.push(ogImage);
        body = description;
      }
    } catch { /* use what we have */ }
  }

  if (!title) title = "X Post";

  return {
    title,
    description: description || title,
    body: body || description || title,
    images,
    url,
    siteName: "X (Twitter)",
    type: "social",
    author,
  };
}

/** Facebook extraction via oEmbed + direct fetch */
async function extractFacebook(url: string): Promise<ExtractedContent> {
  let title = "";
  let description = "";
  let author = "";
  let images: string[] = [];
  let body = "";

  // Method 1: Facebook oEmbed API (works for public posts without auth token)
  try {
    const oembedUrl = `https://www.facebook.com/plugins/post/oembed.json/?url=${encodeURIComponent(url)}`;
    const res = await fetch(oembedUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      if (data.author_name) author = data.author_name;
      if (data.html) {
        // oEmbed HTML contains the post text
        const textContent = stripHtml(data.html);
        if (textContent.length > 20) {
          body = textContent.slice(0, MAX_BODY_LENGTH);
          title = data.author_name
            ? `${data.author_name}'s Facebook Post`
            : "Facebook Post";
          description = body.slice(0, 300);
        }
      }
    }
  } catch { /* try next method */ }

  // Method 2: Direct fetch with full browser-like headers
  if (!body) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
      if (res.ok) {
        const html = await res.text();
        const ogTitle = getMeta(html, "og:title");
        if (ogTitle) title = ogTitle;
        description = getMeta(html, "og:description") || getMeta(html, "description");
        const ogImage = getMeta(html, "og:image");
        if (ogImage) images.push(ogImage);
        body = description || stripHtml(html).slice(0, MAX_BODY_LENGTH);
        if (!author) {
          const authorFromTitle = (ogTitle || "").match(/^(.+?)(?:\s*[-–|]|\s+on Facebook)/);
          if (authorFromTitle) author = authorFromTitle[1]!.trim();
        }
      }
    } catch { /* use what we have */ }
  }

  // Method 3: Try mobile Facebook URL (often less restrictive)
  if (!body || body.length < 50) {
    try {
      const mobileUrl = url.replace("www.facebook.com", "m.facebook.com");
      const res = await fetch(mobileUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
      if (res.ok) {
        const html = await res.text();
        if (!title) title = getMeta(html, "og:title") || getTitle(html);
        if (!description) description = getMeta(html, "og:description") || getMeta(html, "description");
        const ogImage = getMeta(html, "og:image");
        if (ogImage && !images.includes(ogImage)) images.push(ogImage);

        // Mobile FB often has post content in story_body_container or userContent
        const storyMatch = html.match(/class="[^"]*(?:story_body_container|userContent)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        if (storyMatch?.[1]) {
          const storyText = stripHtml(storyMatch[1]);
          if (storyText.length > body.length) body = storyText.slice(0, MAX_BODY_LENGTH);
        }

        if (!body || body.length < 50) {
          body = description || stripHtml(html).slice(0, MAX_BODY_LENGTH);
        }
      }
    } catch { /* use what we have */ }
  }

  if (!title) {
    title = author ? `${author}'s Facebook Post` : "Facebook Post";
  }

  return {
    title,
    description: description || body.slice(0, 300) || title,
    body: body || description || title,
    images,
    url,
    siteName: "Facebook",
    type: "social",
    author,
  };
}

/** LinkedIn extraction via oEmbed + direct fetch */
async function extractLinkedIn(url: string): Promise<ExtractedContent> {
  let title = "";
  let description = "";
  let author = "";
  let images: string[] = [];
  let body = "";

  // Method 1: Direct fetch with browser headers (LinkedIn serves OG tags to crawlers)
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
    if (res.ok) {
      const html = await res.text();
      title = getMeta(html, "og:title") || getTitle(html);
      description = getMeta(html, "og:description") || getMeta(html, "description");
      const ogImage = getMeta(html, "og:image");
      if (ogImage) images.push(ogImage);
      body = description;
      // LinkedIn OG title often has author info
      if (title) {
        const authorMatch = title.match(/^(.+?)\s+(?:on LinkedIn|posted on)/i);
        if (authorMatch) author = authorMatch[1]!.trim();
      }
    }
  } catch { /* try next method */ }

  // Method 2: Try LinkedIn oEmbed
  if (!body) {
    try {
      const oembedUrl = `https://www.linkedin.com/oembed?url=${encodeURIComponent(url)}&format=json`;
      const res = await fetch(oembedUrl, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data.title && !title) title = data.title;
        if (data.author_name && !author) author = data.author_name;
        if (data.html) {
          const textContent = stripHtml(data.html);
          if (textContent.length > 20) body = textContent.slice(0, MAX_BODY_LENGTH);
        }
      }
    } catch { /* use what we have */ }
  }

  if (!title) {
    title = author ? `${author}'s LinkedIn Post` : "LinkedIn Post";
  }

  return {
    title,
    description: description || body.slice(0, 300) || title,
    body: body || description || title,
    images,
    url,
    siteName: "LinkedIn",
    type: "social",
    author,
  };
}

/** Main extraction function */
export async function extractUrlContent(url: string): Promise<ExtractedContent> {
  // Validate URL
  try {
    new URL(url);
  } catch {
    throw new Error("Invalid URL provided");
  }

  const urlType = detectUrlType(url);

  if (urlType === "youtube") {
    return extractYouTube(url);
  }
  if (urlType === "instagram") {
    return extractInstagram(url);
  }
  if (urlType === "twitter") {
    return extractTwitter(url);
  }
  if (urlType === "facebook") {
    return extractFacebook(url);
  }
  if (urlType === "linkedin") {
    return extractLinkedIn(url);
  }

  return extractWebPage(url);
}
