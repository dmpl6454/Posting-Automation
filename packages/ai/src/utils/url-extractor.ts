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

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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

/** Generic web page extraction */
async function extractWebPage(url: string): Promise<ExtractedContent> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch URL: HTTP ${res.status}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    throw new Error(`URL returned non-HTML content: ${contentType}`);
  }

  const html = await res.text();

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

/** Instagram extraction via oEmbed API */
async function extractInstagram(url: string): Promise<ExtractedContent> {
  // Instagram blocks normal fetches — use oEmbed API
  let title = "";
  let description = "";
  let author = "";
  let images: string[] = [];
  let body = "";

  try {
    const oembedUrl = `https://graph.facebook.com/v18.0/instagram_oembed?url=${encodeURIComponent(url)}&access_token=${process.env.FACEBOOK_APP_ID}|${process.env.FACEBOOK_APP_SECRET}&fields=thumbnail_url,author_name,title`;
    const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) {
      const data = (await res.json()) as any;
      title = data.title || "";
      author = data.author_name || "";
      if (data.thumbnail_url) images.push(data.thumbnail_url);
    }
  } catch { /* fallback to page scrape */ }

  // Fallback: try fetching the page with a browser-like User-Agent
  if (!title) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
      if (res.ok) {
        const html = await res.text();
        title = getTitle(html) || "Instagram Post";
        description = getMeta(html, "og:description") || getMeta(html, "description");
        const ogImage = getMeta(html, "og:image");
        if (ogImage && !images.includes(ogImage)) images.push(ogImage);
        body = description;
        if (!author) author = getMeta(html, "og:title")?.split("on Instagram")?.[0]?.trim() || "";
      }
    } catch { /* use what we have */ }
  }

  // If still no title, extract from URL
  if (!title) {
    title = "Instagram Post";
    const pathMatch = url.match(/instagram\.com\/(p|reel|tv)\/([^/?]+)/);
    if (pathMatch) {
      title = `Instagram ${pathMatch[1] === "reel" ? "Reel" : "Post"}`;
    }
  }

  return {
    title,
    description: description || title,
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

  return extractWebPage(url);
}
