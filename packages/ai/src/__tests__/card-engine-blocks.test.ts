import { describe, it, expect } from "vitest";
import {
  renderBackground, DEFAULT_CONTROLS,
  type BackgroundBlockProps, type StyleControls,
} from "../tools/card-engine";

const C: StyleControls = { ...DEFAULT_CONTROLS };

describe("renderBackground", () => {
  it("photo mode uses the sanitized image as cover bg", () => {
    const html = renderBackground({ mode: "photo", imageUrl: "https://cdn.x/p.jpg" }, C);
    expect(html).toContain("https://cdn.x/p.jpg");
    expect(html).toContain("background-size:cover");
  });

  it("photo mode with a malicious url falls back to gradient (no breakout)", () => {
    const html = renderBackground(
      { mode: "photo", imageUrl: `https://x/p.jpg);}</style><script>alert(1)</script>` },
      C,
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("linear-gradient(");
  });

  it("ai mode renders the provided AI image like a photo", () => {
    const html = renderBackground({ mode: "ai", imageUrl: "data:image/png;base64,AAAA" }, C);
    expect(html).toContain("data:image/png;base64,AAAA");
  });

  it("gradient mode renders a branded gradient from the controls brand color", () => {
    const html = renderBackground({ mode: "gradient" }, { ...C, brandColor: "#123456" });
    expect(html).toContain("#123456");
    expect(html).toContain("linear-gradient(");
  });

  it("splitPhotos renders a 2-up grid when two images are present", () => {
    const html = renderBackground(
      { mode: "splitPhotos", imageUrls: ["https://x/a.jpg", "https://x/b.jpg"] }, C);
    expect(html).toContain("https://x/a.jpg");
    expect(html).toContain("https://x/b.jpg");
    expect(html).toContain("grid-template-columns:1fr 1fr");
  });

  it("photoGrid renders up to 4 tiles", () => {
    const html = renderBackground(
      { mode: "photoGrid", imageUrls: ["https://x/1.jpg","https://x/2.jpg","https://x/3.jpg","https://x/4.jpg"] }, C);
    expect((html.match(/https:\/\/x\//g) || []).length).toBe(4);
  });

  it("topTextBottomPhoto renders an escaped text band + photo", () => {
    const html = renderBackground(
      { mode: "topTextBottomPhoto", imageUrl: "https://x/p.jpg", overlayText: "<b>BIG</b>" }, C);
    expect(html).toContain("&lt;b&gt;BIG");
    expect(html).toContain("https://x/p.jpg");
  });

  it("screenshot mode renders a device frame around the image", () => {
    const html = renderBackground({ mode: "screenshot", imageUrl: "https://x/ui.jpg" }, C);
    expect(html).toContain("https://x/ui.jpg");
    expect(html).toContain("screenshot-frame");
  });

  it("subjectComposite with no image degrades to gradient (never broken slot)", () => {
    const html = renderBackground({ mode: "subjectComposite" }, C);
    expect(html).toContain("linear-gradient(");
  });
});
