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
  const gradientFrom = options.gradientFrom || "#1a1a2e";
  const gradientTo = options.gradientTo || "#16213e";
  const accentColor = options.accentColor || "#e94560";
  const date = options.date || new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  let headlineFontSize = 52;
  if (options.headline.length > 100) headlineFontSize = 36;
  else if (options.headline.length > 70) headlineFontSize = 42;
  else if (options.headline.length > 40) headlineFontSize = 48;

  const logoHtml = options.logoUrl
    ? `<img src="${options.logoUrl}" style="width: 48px; height: 48px; border-radius: 8px; object-fit: contain;" />`
    : "";

  const handleHtml = options.handle
    ? `<span style="color: rgba(255,255,255,0.7); font-size: 18px;">${options.handle}</span>`
    : "";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${width}px;
    height: ${height}px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: linear-gradient(135deg, ${gradientFrom}, ${gradientTo});
    color: white;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 60px;
    overflow: hidden;
  }
  .top-bar {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .news-badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: ${accentColor};
    padding: 8px 20px;
    border-radius: 24px;
    font-size: 16px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
  }
  .headline {
    font-size: ${headlineFontSize}px;
    font-weight: 800;
    line-height: 1.2;
    letter-spacing: -0.5px;
    text-shadow: 0 2px 20px rgba(0,0,0,0.3);
  }
  .bottom-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .source-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .source-name {
    font-size: 20px;
    font-weight: 600;
    color: rgba(255,255,255,0.9);
  }
  .date-text {
    font-size: 16px;
    color: rgba(255,255,255,0.6);
  }
  .branding {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .divider {
    width: 60px;
    height: 4px;
    background: ${accentColor};
    border-radius: 2px;
  }
</style>
</head>
<body>
  <div>
    <div class="top-bar">
      ${logoHtml}
      <div class="news-badge">📰 Trending News</div>
    </div>
  </div>

  <div>
    <div class="divider" style="margin-bottom: 24px;"></div>
    <div class="headline">${escapeHtml(options.headline)}</div>
  </div>

  <div class="bottom-bar">
    <div class="source-info">
      <div class="source-name">Source: ${escapeHtml(options.source)}</div>
      <div class="date-text">${date}</div>
    </div>
    <div class="branding">
      ${handleHtml}
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
  bgSeed?: number; // for stock photo fallback
  backgroundImageUrl?: string; // AI-generated background (data URL or http URL)
  date?: string;
}

const CREATIVE_THEME: Record<string, {
  accentColor: string; headlineColor: string; tag: string; tagBg: string; tagColor: string;
  gradient: string; overlayGradient: string; tintColor: string;
}> = {
  breaking_news: {
    accentColor: "#ff1a1a", headlineColor: "#ffffff",
    tag: "⚡ BREAKING", tagBg: "rgba(180,0,0,0.75)", tagColor: "#fff",
    gradient: "linear-gradient(180deg,#0d0000 0%,#1a0000 50%,#0d0000 100%)",
    overlayGradient: "linear-gradient(180deg,rgba(0,0,0,0.5) 0%,rgba(0,0,0,0.1) 30%,rgba(0,0,0,0.35) 55%,rgba(0,0,0,0.88) 78%,rgba(0,0,0,0.97) 100%)",
    tintColor: "rgba(180,0,0,0.25)",
  },
  luxury_news: {
    accentColor: "#c9a84c", headlineColor: "#fff8e7",
    tag: "✦ EXCLUSIVE", tagBg: "rgba(0,0,0,0.65)", tagColor: "#c9a84c",
    gradient: "linear-gradient(160deg,#080808 0%,#1a1500 60%,#080808 100%)",
    overlayGradient: "linear-gradient(180deg,rgba(0,0,0,0.45) 0%,rgba(0,0,0,0.05) 30%,rgba(0,0,0,0.3) 55%,rgba(0,0,0,0.85) 75%,rgba(0,0,0,0.97) 100%)",
    tintColor: "rgba(60,40,0,0.2)",
  },
  cinematic: {
    accentColor: "#d4af37", headlineColor: "#ffffff",
    tag: "", tagBg: "", tagColor: "",
    gradient: "linear-gradient(180deg,#000 0%,#0a0a1a 50%,#000 100%)",
    overlayGradient: "linear-gradient(180deg,rgba(0,0,0,0.55) 0%,rgba(0,0,0,0.1) 35%,rgba(0,0,0,0.3) 55%,rgba(0,0,0,0.88) 78%,rgba(0,0,0,0.97) 100%)",
    tintColor: "rgba(0,0,20,0.2)",
  },
  viral_entertainment: {
    accentColor: "#c940ff", headlineColor: "#ffffff",
    tag: "🔥 VIRAL", tagBg: "rgba(100,0,160,0.75)", tagColor: "#fff",
    gradient: "linear-gradient(135deg,#1a0033 0%,#2d0052 40%,#0d001a 100%)",
    overlayGradient: "linear-gradient(180deg,rgba(0,0,0,0.5) 0%,rgba(0,0,0,0.1) 30%,rgba(0,0,0,0.3) 55%,rgba(0,0,0,0.85) 75%,rgba(0,0,0,0.97) 100%)",
    tintColor: "rgba(100,0,160,0.25)",
  },
  paparazzi_stamp: {
    accentColor: "#ff6600", headlineColor: "#ffffff",
    tag: "📸 SPOTTED", tagBg: "rgba(180,60,0,0.75)", tagColor: "#fff",
    gradient: "linear-gradient(180deg,#080808 0%,#111 100%)",
    overlayGradient: "linear-gradient(180deg,rgba(0,0,0,0.5) 0%,rgba(0,0,0,0.1) 30%,rgba(0,0,0,0.35) 55%,rgba(0,0,0,0.88) 78%,rgba(0,0,0,0.97) 100%)",
    tintColor: "rgba(80,30,0,0.2)",
  },
  minimal_dark: {
    accentColor: "#ffffff", headlineColor: "#ffffff",
    tag: "", tagBg: "", tagColor: "",
    gradient: "linear-gradient(180deg,#000 0%,#0a0a0a 100%)",
    overlayGradient: "linear-gradient(180deg,rgba(0,0,0,0.6) 0%,rgba(0,0,0,0.15) 35%,rgba(0,0,0,0.4) 55%,rgba(0,0,0,0.9) 78%,rgba(0,0,0,0.98) 100%)",
    tintColor: "rgba(0,0,0,0.15)",
  },
  magazine: {
    accentColor: "#e8e8e8", headlineColor: "#ffffff",
    tag: "MAGAZINE", tagBg: "rgba(0,0,0,0.65)", tagColor: "#e8e8e8",
    gradient: "linear-gradient(180deg,#0c0c0c 0%,#1a1a1a 55%,#0c0c0c 100%)",
    overlayGradient: "linear-gradient(180deg,rgba(0,0,0,0.55) 0%,rgba(0,0,0,0.1) 35%,rgba(0,0,0,0.35) 55%,rgba(0,0,0,0.88) 78%,rgba(0,0,0,0.97) 100%)",
    tintColor: "rgba(20,20,20,0.1)",
  },
  quote_typography: {
    accentColor: "#4a9eff", headlineColor: "#ffffff",
    tag: "", tagBg: "", tagColor: "",
    gradient: "linear-gradient(135deg,#050510 0%,#0a0a20 100%)",
    overlayGradient: "linear-gradient(180deg,rgba(0,0,0,0.5) 0%,rgba(0,0,0,0.1) 35%,rgba(0,0,0,0.3) 55%,rgba(0,0,0,0.88) 78%,rgba(0,0,0,0.97) 100%)",
    tintColor: "rgba(0,20,60,0.2)",
  },
};

export function generateStaticNewsCreativeHtml(options: StaticNewsCreativeOptions): string {
  const theme = CREATIVE_THEME[options.template] ?? CREATIVE_THEME["cinematic"]!;
  const seed = options.bgSeed ?? Math.abs(options.headline.split("").reduce((a, c) => a + c.charCodeAt(0), 42)) % 1000;
  const date = options.date ?? new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();

  // Extract keywords from headline for relevant background image
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
  const fontSize = words <= 6 ? 90 : words <= 9 ? 72 : words <= 13 ? 58 : 48;

  const initial = (options.channelName[0] ?? "N").toUpperCase();
  const logoHtml = options.logoUrl
    ? `<img src="${options.logoUrl}" style="width:80px;height:80px;border-radius:12px;object-fit:contain;border:2px solid ${theme.accentColor}66;background:rgba(0,0,0,0.3);flex-shrink:0;" />`
    : `<div style="width:80px;height:80px;border-radius:12px;background:${theme.accentColor};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:36px;flex-shrink:0;border:2px solid ${theme.accentColor}66;">${initial}</div>`;

  const tagHtml = theme.tag
    ? `<div style="position:absolute;top:40px;left:40px;background:${theme.tagBg};border:2px solid ${theme.accentColor};color:${theme.tagColor};padding:12px 28px;border-radius:8px;font-size:22px;font-weight:900;letter-spacing:0.12em;text-transform:uppercase;backdrop-filter:blur(4px);">${escapeHtml(theme.tag)}</div>`
    : "";

  const quoteHtml = options.template === "quote_typography"
    ? `<div style="position:absolute;top:-20px;left:-10px;color:${theme.accentColor};font-size:140px;line-height:0.6;font-family:Georgia,serif;opacity:0.4;">"</div>`
    : "";

  const textTransform = options.template === "magazine" ? "uppercase" : "none";
  const letterSpacing = options.template === "minimal_dark" ? "-0.03em" : "-0.02em";

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box;}
body{width:1080px;height:1350px;overflow:hidden;position:relative;font-family:'Arial Black','Arial Bold',Arial,sans-serif;background:#000;}
.bg-photo{position:absolute;inset:0;background-image:url(${bgUrl});background-size:cover;background-position:center;}
.overlay{position:absolute;inset:0;background:${theme.overlayGradient};}
.tint{position:absolute;inset:0;background:${theme.tintColor};}
.accent-top{position:absolute;top:0;left:0;right:0;height:8px;background:${theme.accentColor};}
.date{position:absolute;top:48px;right:40px;color:rgba(255,255,255,0.6);font-size:18px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;}
.headline-block{position:absolute;bottom:188px;left:40px;right:40px;}
.accent-rule{width:80px;height:6px;background:${theme.accentColor};border-radius:3px;margin-bottom:24px;}
.headline{color:${theme.headlineColor};font-size:${fontSize}px;font-weight:900;line-height:1.1;letter-spacing:${letterSpacing};text-transform:${textTransform};text-shadow:0 3px 24px rgba(0,0,0,0.95);word-break:break-word;position:relative;}
.footer{position:absolute;bottom:0;left:0;right:0;height:180px;background:linear-gradient(0deg,rgba(0,0,0,0.97) 0%,rgba(0,0,0,0.55) 100%);border-top:1px solid ${theme.accentColor}44;display:flex;align-items:center;padding:0 40px;gap:24px;}
.channel-name{color:#fff;font-size:30px;font-weight:800;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.channel-handle{color:${theme.accentColor};font-size:22px;font-weight:600;margin-top:6px;letter-spacing:0.04em;}
.accent-dot{width:14px;height:14px;border-radius:50%;background:${theme.accentColor};flex-shrink:0;box-shadow:0 0 14px ${theme.accentColor};}
.accent-bottom{position:absolute;bottom:0;left:0;right:0;height:6px;background:${theme.accentColor};}
</style></head><body>
<div class="bg-photo"></div>
<div class="overlay"></div>
<div class="tint"></div>
<div class="accent-top"></div>
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
    <div class="channel-handle">@${escapeHtml(options.handle)}</div>
  </div>
  <div class="accent-dot"></div>
</div>
<div class="accent-bottom"></div>
</body></html>`;
}
