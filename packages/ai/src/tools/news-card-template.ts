export interface NewsCardOptions {
  headline: string;
  source: string;
  sourceUrl?: string;
  logoUrl?: string;
  handle?: string;
  date?: string;
  platform: "instagram" | "twitter" | "linkedin" | "facebook";
  gradientFrom?: string;
  gradientTo?: string;
  accentColor?: string;
}

function getDimensions(platform: string): { width: number; height: number } {
  switch (platform) {
    case "instagram":
      return { width: 1080, height: 1080 };
    case "twitter":
    case "linkedin":
    case "facebook":
    default:
      return { width: 1200, height: 675 };
  }
}

export function generateNewsCardHtml(options: NewsCardOptions): string {
  const { width, height } = getDimensions(options.platform);
  const accentColor = options.accentColor || "#6366f1";
  const date = options.date || new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const charLen = options.headline.length;
  let headlineFontSize = 56;
  if (charLen > 120) headlineFontSize = 34;
  else if (charLen > 90) headlineFontSize = 38;
  else if (charLen > 60) headlineFontSize = 44;
  else if (charLen > 40) headlineFontSize = 50;

  const logoHtml = options.logoUrl
    ? `<img src="${escapeHtml(options.logoUrl)}" style="width:44px;height:44px;border-radius:10px;object-fit:contain;" />`
    : "";

  const handleHtml = "";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
  *{margin:0;padding:0;box-sizing:border-box;}
  body{
    width:${width}px;height:${height}px;
    font-family:'Inter',system-ui,-apple-system,sans-serif;
    background:#0a0a0e;
    color:white;overflow:hidden;position:relative;
  }
  .bg{position:absolute;inset:0;background:
    radial-gradient(ellipse 70% 50% at 15% 10%,${accentColor}10 0%,transparent 60%),
    linear-gradient(170deg,#0a0a0e 0%,#0e0e14 100%);
  }
  .content{position:relative;z-index:1;height:100%;display:flex;flex-direction:column;justify-content:space-between;padding:${height > 800 ? 56 : 44}px;}
  .top{display:flex;align-items:center;justify-content:space-between;}
  .badge{display:inline-flex;align-items:center;gap:8px;background:${accentColor};padding:8px 16px;border-radius:4px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;}
  .middle{flex:1;display:flex;flex-direction:column;justify-content:center;padding:${height > 800 ? '32px 0' : '20px 0'};}
  .rule{width:40px;height:3px;background:${accentColor};border-radius:2px;margin-bottom:20px;}
  .headline{font-size:${headlineFontSize}px;font-weight:800;line-height:1.15;letter-spacing:-0.02em;color:#fff;max-width:90%;}
  .bottom{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;}
  .meta{display:flex;flex-direction:column;gap:4px;}
  .source{font-size:13px;font-weight:600;color:rgba(255,255,255,0.55);text-transform:uppercase;letter-spacing:0.06em;}
  .date{font-size:12px;font-weight:400;color:rgba(255,255,255,0.3);}
  .branding{display:flex;align-items:center;gap:12px;}
</style>
</head>
<body>
<div class="bg"></div>
<div class="content">
  <div class="top">
    <div class="badge">TRENDING</div>
    <div class="branding">${handleHtml}${logoHtml}</div>
  </div>
  <div class="middle">
    <div class="rule"></div>
    <div class="headline">${escapeHtml(options.headline)}</div>
  </div>
  <div class="bottom">
    <div class="meta">
      <div class="source">${escapeHtml(options.source)}</div>
      <div class="date">${date}</div>
    </div>
  </div>
</div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─────────────────────────────────────────────────────────────────────────────
// Static News Creative — Instagram 4:5 (1080×1350) full-bleed image creative
// ─────────────────────────────────────────────────────────────────────────────

export interface StaticNewsCreativeOptions {
  headline: string;
  channelName: string;
  handle: string;
  logoUrl?: string | null;
  template: "breaking_news" | "luxury_news" | "cinematic" | "viral_entertainment" | "paparazzi_stamp" | "minimal_dark" | "magazine" | "quote_typography";
  bgSeed?: number;
  backgroundImageUrl?: string;
  date?: string;
}

const CREATIVE_THEME: Record<string, {
  accentColor: string; headlineColor: string; tag: string; tagBg: string; tagColor: string;
  gradient: string; overlayGradient: string; tintColor: string;
}> = {
  breaking_news: {
    accentColor: "#dc2626", headlineColor: "#ffffff",
    tag: "BREAKING", tagBg: "#dc2626", tagColor: "#fff",
    gradient: "linear-gradient(180deg,#000 0%,#0a0a0a 100%)",
    overlayGradient: "linear-gradient(180deg,transparent 0%,rgba(0,0,0,0.15) 40%,rgba(0,0,0,0.85) 70%,rgba(0,0,0,0.98) 100%)",
    tintColor: "transparent",
  },
  luxury_news: {
    accentColor: "#c9a84c", headlineColor: "#ffffff",
    tag: "EXCLUSIVE", tagBg: "rgba(0,0,0,0.65)", tagColor: "#c9a84c",
    gradient: "linear-gradient(180deg,#080808 0%,#111 100%)",
    overlayGradient: "linear-gradient(180deg,transparent 0%,rgba(0,0,0,0.15) 40%,rgba(0,0,0,0.85) 70%,rgba(0,0,0,0.98) 100%)",
    tintColor: "transparent",
  },
  cinematic: {
    accentColor: "#8b5cf6", headlineColor: "#ffffff",
    tag: "", tagBg: "", tagColor: "",
    gradient: "linear-gradient(180deg,#050510 0%,#0a0a1a 100%)",
    overlayGradient: "linear-gradient(180deg,transparent 0%,rgba(0,0,0,0.15) 40%,rgba(0,0,0,0.85) 70%,rgba(0,0,0,0.98) 100%)",
    tintColor: "transparent",
  },
  viral_entertainment: {
    accentColor: "#a855f7", headlineColor: "#ffffff",
    tag: "VIRAL", tagBg: "#7c3aed", tagColor: "#fff",
    gradient: "linear-gradient(180deg,#0d001a 0%,#1a0033 100%)",
    overlayGradient: "linear-gradient(180deg,transparent 0%,rgba(0,0,0,0.15) 40%,rgba(0,0,0,0.85) 70%,rgba(0,0,0,0.98) 100%)",
    tintColor: "transparent",
  },
  paparazzi_stamp: {
    accentColor: "#ea580c", headlineColor: "#ffffff",
    tag: "SPOTTED", tagBg: "#c2410c", tagColor: "#fff",
    gradient: "linear-gradient(180deg,#080808 0%,#111 100%)",
    overlayGradient: "linear-gradient(180deg,transparent 0%,rgba(0,0,0,0.15) 40%,rgba(0,0,0,0.85) 70%,rgba(0,0,0,0.98) 100%)",
    tintColor: "transparent",
  },
  minimal_dark: {
    accentColor: "#d4d4d4", headlineColor: "#ffffff",
    tag: "", tagBg: "", tagColor: "",
    gradient: "linear-gradient(180deg,#000 0%,#0a0a0a 100%)",
    overlayGradient: "linear-gradient(180deg,transparent 0%,rgba(0,0,0,0.2) 40%,rgba(0,0,0,0.88) 70%,rgba(0,0,0,0.98) 100%)",
    tintColor: "transparent",
  },
  magazine: {
    accentColor: "#e5e5e5", headlineColor: "#ffffff",
    tag: "FEATURE", tagBg: "rgba(0,0,0,0.6)", tagColor: "#e5e5e5",
    gradient: "linear-gradient(180deg,#0c0c0c 0%,#111 100%)",
    overlayGradient: "linear-gradient(180deg,transparent 0%,rgba(0,0,0,0.15) 40%,rgba(0,0,0,0.85) 70%,rgba(0,0,0,0.98) 100%)",
    tintColor: "transparent",
  },
  quote_typography: {
    accentColor: "#3b82f6", headlineColor: "#ffffff",
    tag: "", tagBg: "", tagColor: "",
    gradient: "linear-gradient(180deg,#050510 0%,#0a0a1a 100%)",
    overlayGradient: "linear-gradient(180deg,transparent 0%,rgba(0,0,0,0.2) 40%,rgba(0,0,0,0.85) 70%,rgba(0,0,0,0.98) 100%)",
    tintColor: "transparent",
  },
};

export function generateStaticNewsCreativeHtml(options: StaticNewsCreativeOptions): string {
  const theme = CREATIVE_THEME[options.template] ?? CREATIVE_THEME["cinematic"]!;
  const seed = options.bgSeed ?? Math.abs(options.headline.split("").reduce((a, c) => a + c.charCodeAt(0), 42)) % 1000;
  const date = options.date ?? new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }).toUpperCase();

  // Extract keywords for fallback background
  const stopWords = new Set(["the","a","an","is","are","was","were","in","on","at","to","for","of","and","or","but","with","has","have","had","not","no","this","that","it","its","from","by","as","be","been","will","would","could","should","may","might","can","do","does","did","about","after","all","also","than","then","very","just","over","such","more","most","other","into","out","up","down","so","if","new","says","said"]);
  const keywords = options.headline
    .replace(/[^a-zA-Z\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w.toLowerCase()))
    .slice(0, 3)
    .map((w) => w.toLowerCase())
    .join(",");
  const bgQuery = keywords || "news";
  const bgUrl = options.backgroundImageUrl || `https://loremflickr.com/1080/1350/${bgQuery}?lock=${seed}`;

  const words = options.headline.trim().split(/\s+/).length;
  const fontSize = words <= 5 ? 82 : words <= 8 ? 66 : words <= 12 ? 54 : words <= 16 ? 46 : 40;

  const initial = (options.channelName[0] ?? "N").toUpperCase();
  const logoHtml = options.logoUrl
    ? `<img src="${escapeHtml(options.logoUrl)}" style="width:56px;height:56px;border-radius:14px;object-fit:contain;border:2px solid rgba(255,255,255,0.15);flex-shrink:0;" />`
    : `<div style="width:56px;height:56px;border-radius:14px;background:${theme.accentColor};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:24px;flex-shrink:0;">${initial}</div>`;

  const tagHtml = theme.tag
    ? `<div class="tag">${escapeHtml(theme.tag)}</div>`
    : "";

  const quoteHtml = options.template === "quote_typography"
    ? `<div style="position:absolute;top:-30px;left:-8px;color:${theme.accentColor};font-size:160px;line-height:0.5;font-family:Georgia,serif;opacity:0.25;">\u201C</div>`
    : "";

  const textTransform = options.template === "magazine" ? "uppercase" : "none";

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
*{margin:0;padding:0;box-sizing:border-box;}
body{width:1080px;height:1350px;overflow:hidden;position:relative;font-family:'Inter',system-ui,-apple-system,sans-serif;background:#000;-webkit-font-smoothing:antialiased;}
.bg-photo{position:absolute;inset:0;background-image:url(${bgUrl});background-size:cover;background-position:center top;}
.overlay{position:absolute;inset:0;background:${theme.overlayGradient};}
/* Tag badge */
.tag{position:absolute;top:48px;left:48px;background:${theme.tagBg};color:${theme.tagColor};padding:10px 20px;border-radius:4px;font-size:13px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;}
/* Date */
.date{position:absolute;top:52px;right:48px;color:rgba(255,255,255,0.5);font-size:13px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;}
/* Headline area — positioned above footer */
.headline-block{position:absolute;bottom:140px;left:48px;right:48px;}
.accent-rule{width:40px;height:3px;background:${theme.accentColor};border-radius:2px;margin-bottom:18px;}
.headline{color:${theme.headlineColor};font-size:${fontSize}px;font-weight:800;line-height:1.12;letter-spacing:-0.02em;text-transform:${textTransform};word-break:break-word;position:relative;}
/* Footer — clean, no extra gradient */
.footer{position:absolute;bottom:0;left:0;right:0;height:110px;display:flex;align-items:center;padding:0 48px;gap:16px;}
.channel-name{color:rgba(255,255,255,0.9);font-size:18px;font-weight:600;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.channel-handle{color:${theme.accentColor};font-size:13px;font-weight:500;margin-top:2px;opacity:0.7;}
</style></head><body>
<div class="bg-photo"></div>
<div class="overlay"></div>
${tagHtml}
<div class="date">${date}</div>
<div class="headline-block">
  <div class="accent-rule"></div>
  <div class="headline" style="position:relative;">${quoteHtml}${escapeHtml(options.headline)}</div>
</div>
<div class="footer">
  ${logoHtml}
  <div style="flex:1;min-width:0;">
    <div class="channel-name">${escapeHtml(options.channelName)}</div>
  </div>
</div>
</body></html>`;
}
