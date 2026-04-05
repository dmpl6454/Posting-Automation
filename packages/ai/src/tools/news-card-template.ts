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
    background:#0a0a0f;
    color:white;overflow:hidden;position:relative;
  }
  /* Subtle mesh gradient background */
  .bg{position:absolute;inset:0;background:
    radial-gradient(ellipse 80% 60% at 20% 10%,${accentColor}18 0%,transparent 60%),
    radial-gradient(ellipse 60% 50% at 80% 90%,${accentColor}12 0%,transparent 50%),
    linear-gradient(170deg,#0a0a14 0%,#0f0f1a 40%,#0a0a14 100%);
  }
  /* Noise texture overlay */
  .noise{position:absolute;inset:0;opacity:0.03;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E");background-size:128px 128px;}
  .content{position:relative;z-index:1;height:100%;display:flex;flex-direction:column;justify-content:space-between;padding:${height > 800 ? 64 : 48}px;}
  .top{display:flex;align-items:center;justify-content:space-between;}
  .badge{display:inline-flex;align-items:center;gap:8px;background:${accentColor};padding:8px 18px;border-radius:6px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;}
  .badge-dot{width:6px;height:6px;border-radius:50%;background:#fff;animation:pulse 2s infinite;}
  .middle{flex:1;display:flex;flex-direction:column;justify-content:center;padding:${height > 800 ? '40px 0' : '24px 0'};}
  .rule{width:48px;height:3px;background:${accentColor};border-radius:2px;margin-bottom:24px;}
  .headline{font-size:${headlineFontSize}px;font-weight:800;line-height:1.15;letter-spacing:-0.03em;color:#fff;max-width:90%;}
  .bottom{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;}
  .meta{display:flex;flex-direction:column;gap:6px;}
  .source{font-size:14px;font-weight:600;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:0.06em;}
  .date{font-size:13px;font-weight:400;color:rgba(255,255,255,0.35);}
  .branding{display:flex;align-items:center;gap:12px;}
  /* Border accent */
  .border-line{position:absolute;bottom:0;left:0;right:0;height:4px;background:linear-gradient(90deg,${accentColor},${accentColor}88,transparent);}
</style>
</head>
<body>
<div class="bg"></div>
<div class="noise"></div>
<div class="content">
  <div class="top">
    <div class="badge"><div class="badge-dot"></div>TRENDING</div>
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
<div class="border-line"></div>
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
    accentColor: "#ef4444", headlineColor: "#ffffff",
    tag: "BREAKING", tagBg: "rgba(220,38,38,0.85)", tagColor: "#fff",
    gradient: "linear-gradient(180deg,#0c0000 0%,#140000 50%,#0c0000 100%)",
    overlayGradient: "linear-gradient(180deg,rgba(0,0,0,0.35) 0%,rgba(0,0,0,0.05) 25%,rgba(0,0,0,0.15) 50%,rgba(0,0,0,0.75) 72%,rgba(0,0,0,0.95) 100%)",
    tintColor: "rgba(150,0,0,0.15)",
  },
  luxury_news: {
    accentColor: "#d4a853", headlineColor: "#fef3c7",
    tag: "EXCLUSIVE", tagBg: "rgba(0,0,0,0.7)", tagColor: "#d4a853",
    gradient: "linear-gradient(160deg,#080808 0%,#1a1500 60%,#080808 100%)",
    overlayGradient: "linear-gradient(180deg,rgba(0,0,0,0.35) 0%,rgba(0,0,0,0.05) 25%,rgba(0,0,0,0.15) 50%,rgba(0,0,0,0.75) 72%,rgba(0,0,0,0.95) 100%)",
    tintColor: "rgba(50,35,0,0.15)",
  },
  cinematic: {
    accentColor: "#a78bfa", headlineColor: "#ffffff",
    tag: "", tagBg: "", tagColor: "",
    gradient: "linear-gradient(180deg,#050510 0%,#0a0a1a 50%,#050510 100%)",
    overlayGradient: "linear-gradient(180deg,rgba(0,0,0,0.4) 0%,rgba(0,0,0,0.05) 30%,rgba(0,0,0,0.15) 50%,rgba(0,0,0,0.8) 75%,rgba(0,0,0,0.96) 100%)",
    tintColor: "rgba(0,0,30,0.15)",
  },
  viral_entertainment: {
    accentColor: "#c084fc", headlineColor: "#ffffff",
    tag: "VIRAL", tagBg: "rgba(88,28,135,0.8)", tagColor: "#fff",
    gradient: "linear-gradient(135deg,#1a0033 0%,#2d0052 40%,#0d001a 100%)",
    overlayGradient: "linear-gradient(180deg,rgba(0,0,0,0.35) 0%,rgba(0,0,0,0.05) 25%,rgba(0,0,0,0.15) 50%,rgba(0,0,0,0.75) 72%,rgba(0,0,0,0.95) 100%)",
    tintColor: "rgba(88,28,135,0.18)",
  },
  paparazzi_stamp: {
    accentColor: "#f97316", headlineColor: "#ffffff",
    tag: "SPOTTED", tagBg: "rgba(154,52,18,0.8)", tagColor: "#fff",
    gradient: "linear-gradient(180deg,#080808 0%,#111 100%)",
    overlayGradient: "linear-gradient(180deg,rgba(0,0,0,0.35) 0%,rgba(0,0,0,0.05) 25%,rgba(0,0,0,0.15) 50%,rgba(0,0,0,0.75) 72%,rgba(0,0,0,0.95) 100%)",
    tintColor: "rgba(80,30,0,0.15)",
  },
  minimal_dark: {
    accentColor: "#e5e5e5", headlineColor: "#ffffff",
    tag: "", tagBg: "", tagColor: "",
    gradient: "linear-gradient(180deg,#000 0%,#0a0a0a 100%)",
    overlayGradient: "linear-gradient(180deg,rgba(0,0,0,0.45) 0%,rgba(0,0,0,0.1) 30%,rgba(0,0,0,0.2) 50%,rgba(0,0,0,0.82) 75%,rgba(0,0,0,0.97) 100%)",
    tintColor: "rgba(0,0,0,0.1)",
  },
  magazine: {
    accentColor: "#e5e5e5", headlineColor: "#ffffff",
    tag: "FEATURE", tagBg: "rgba(0,0,0,0.7)", tagColor: "#e5e5e5",
    gradient: "linear-gradient(180deg,#0c0c0c 0%,#1a1a1a 55%,#0c0c0c 100%)",
    overlayGradient: "linear-gradient(180deg,rgba(0,0,0,0.4) 0%,rgba(0,0,0,0.08) 30%,rgba(0,0,0,0.2) 50%,rgba(0,0,0,0.82) 75%,rgba(0,0,0,0.96) 100%)",
    tintColor: "rgba(20,20,20,0.08)",
  },
  quote_typography: {
    accentColor: "#60a5fa", headlineColor: "#ffffff",
    tag: "", tagBg: "", tagColor: "",
    gradient: "linear-gradient(135deg,#050510 0%,#0a0a20 100%)",
    overlayGradient: "linear-gradient(180deg,rgba(0,0,0,0.4) 0%,rgba(0,0,0,0.08) 30%,rgba(0,0,0,0.2) 50%,rgba(0,0,0,0.82) 75%,rgba(0,0,0,0.96) 100%)",
    tintColor: "rgba(0,20,60,0.15)",
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
.tint{position:absolute;inset:0;background:${theme.tintColor};}
/* Top accent bar */
.accent-top{position:absolute;top:0;left:0;right:0;height:5px;background:${theme.accentColor};}
/* Tag badge */
.tag{position:absolute;top:44px;left:44px;background:${theme.tagBg};color:${theme.tagColor};padding:10px 22px;border-radius:6px;font-size:13px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.08);}
/* Date */
.date{position:absolute;top:48px;right:44px;color:rgba(255,255,255,0.45);font-size:14px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;}
/* Headline area */
.headline-block{position:absolute;bottom:160px;left:44px;right:44px;}
.accent-rule{width:48px;height:4px;background:${theme.accentColor};border-radius:2px;margin-bottom:20px;}
.headline{color:${theme.headlineColor};font-size:${fontSize}px;font-weight:800;line-height:1.1;letter-spacing:-0.03em;text-transform:${textTransform};text-shadow:0 2px 40px rgba(0,0,0,0.8);word-break:break-word;position:relative;}
/* Footer */
.footer{position:absolute;bottom:0;left:0;right:0;height:130px;background:linear-gradient(0deg,rgba(0,0,0,0.95) 0%,rgba(0,0,0,0.4) 100%);display:flex;align-items:center;padding:0 44px;gap:18px;}
.channel-name{color:#fff;font-size:22px;font-weight:700;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.channel-handle{color:${theme.accentColor};font-size:15px;font-weight:600;margin-top:4px;letter-spacing:0.03em;opacity:0.8;}
/* Bottom accent */
.accent-bottom{position:absolute;bottom:0;left:0;right:0;height:4px;background:linear-gradient(90deg,${theme.accentColor},${theme.accentColor}66,transparent);}
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
  </div>
</div>
<div class="accent-bottom"></div>
</body></html>`;
}
