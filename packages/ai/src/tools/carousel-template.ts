/**
 * Carousel Slide Templates
 * Generates HTML for individual carousel slides rendered via Puppeteer.
 * Each slide is 1080x1350 (4:5 Instagram) with consistent branding.
 */

export interface CarouselSlide {
  type: "cover" | "content" | "cta";
  title?: string;
  body?: string;
  slideNumber?: number;
  totalSlides?: number;
}

export interface CarouselOptions {
  slides: CarouselSlide[];
  channelName: string;
  handle?: string;
  logoUrl?: string | null;
  accentColor?: string;
  backgroundImageUrl?: string | null;
  theme?: "dark" | "light" | "gradient";
}

const THEMES = {
  dark: {
    bg: "#0f0f0f",
    text: "#ffffff",
    muted: "#a0a0a0",
    accent: "#6366f1",
    cardBg: "rgba(255,255,255,0.05)",
  },
  light: {
    bg: "#fafafa",
    text: "#1a1a1a",
    muted: "#666666",
    accent: "#6366f1",
    cardBg: "rgba(0,0,0,0.03)",
  },
  gradient: {
    bg: "linear-gradient(135deg, #0f0c29, #302b63, #24243e)",
    text: "#ffffff",
    muted: "#b0b0c0",
    accent: "#818cf8",
    cardBg: "rgba(255,255,255,0.08)",
  },
};

export function generateCarouselSlideHtml(
  slide: CarouselSlide,
  options: CarouselOptions,
  slideIndex: number
): string {
  const theme = THEMES[options.theme || "dark"];
  const accent = options.accentColor || theme.accent;
  const bgStyle = options.theme === "gradient"
    ? `background: ${theme.bg};`
    : `background-color: ${theme.bg};`;

  const bgImageCss = options.backgroundImageUrl && slide.type === "cover"
    ? `background-image: linear-gradient(to bottom, rgba(0,0,0,0.6), rgba(0,0,0,0.85)), url('${options.backgroundImageUrl}');
       background-size: cover; background-position: center;`
    : "";

  const logoHtml = options.logoUrl
    ? `<img src="${options.logoUrl}" style="width:64px;height:64px;border-radius:50%;object-fit:cover;border:3px solid ${accent};" />`
    : `<div style="width:64px;height:64px;border-radius:50%;background:${accent};display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;color:#fff;">${(options.channelName[0] || "?").toUpperCase()}</div>`;

  let contentHtml = "";

  if (slide.type === "cover") {
    contentHtml = `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:60px 50px;">
        ${logoHtml}
        <div style="margin-top:32px;width:60px;height:4px;background:${accent};border-radius:2px;"></div>
        <h1 style="margin-top:32px;font-size:52px;font-weight:800;line-height:1.15;color:${theme.text};letter-spacing:-0.5px;">
          ${escapeHtml(slide.title || "")}
        </h1>
        ${slide.body ? `<p style="margin-top:24px;font-size:22px;color:${theme.muted};line-height:1.5;max-width:800px;">${escapeHtml(slide.body)}</p>` : ""}
      </div>
    `;
  } else if (slide.type === "content") {
    contentHtml = `
      <div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding:60px 60px;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:32px;">
          <div style="width:48px;height:48px;border-radius:50%;background:${accent};display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#fff;">
            ${slideIndex}
          </div>
          ${slide.title ? `<h2 style="font-size:32px;font-weight:700;color:${theme.text};flex:1;">${escapeHtml(slide.title)}</h2>` : ""}
        </div>
        ${slide.body ? `
          <div style="background:${theme.cardBg};border-radius:16px;padding:36px;border-left:4px solid ${accent};">
            <p style="font-size:26px;color:${theme.text};line-height:1.6;margin:0;">
              ${escapeHtml(slide.body)}
            </p>
          </div>
        ` : ""}
      </div>
    `;
  } else if (slide.type === "cta") {
    contentHtml = `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:60px 50px;">
        ${logoHtml}
        <h2 style="margin-top:32px;font-size:44px;font-weight:800;color:${theme.text};">
          ${escapeHtml(slide.title || "Follow for More")}
        </h2>
        ${slide.body ? `<p style="margin-top:16px;font-size:22px;color:${theme.muted};line-height:1.5;">${escapeHtml(slide.body)}</p>` : ""}
        <div style="margin-top:32px;padding:16px 48px;background:${accent};border-radius:50px;font-size:22px;font-weight:700;color:#fff;">
          @${escapeHtml(options.handle || options.channelName)}
        </div>
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
  body { font-family: 'Inter', -apple-system, sans-serif; }
</style>
</head>
<body>
<div style="width:1080px;height:1350px;${bgStyle}${bgImageCss}display:flex;flex-direction:column;overflow:hidden;">
  ${contentHtml}
  <!-- Footer branding -->
  <div style="padding:24px 60px;display:flex;align-items:center;justify-content:space-between;">
    <div style="display:flex;align-items:center;gap:10px;">
      ${options.logoUrl
        ? `<img src="${options.logoUrl}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;" />`
        : `<div style="width:28px;height:28px;border-radius:50%;background:${accent};display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff;">${(options.channelName[0] || "?").toUpperCase()}</div>`
      }
      <span style="font-size:16px;color:${theme.muted};font-weight:600;">@${escapeHtml(options.handle || options.channelName)}</span>
    </div>
    ${slide.slideNumber && slide.totalSlides
      ? `<span style="font-size:14px;color:${theme.muted};font-weight:600;">${slide.slideNumber} / ${slide.totalSlides}</span>`
      : ""}
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
