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
