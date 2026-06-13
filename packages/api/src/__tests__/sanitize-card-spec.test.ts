import { describe, it, expect } from "vitest";
import { sanitizeCardSpecJson } from "../lib/sanitize-card-spec";

describe("sanitizeCardSpecJson — never trust stored JSON", () => {
  it("returns null for a non-object blob", () => {
    expect(sanitizeCardSpecJson(null)).toBeNull();
    expect(sanitizeCardSpecJson("not json")).toBeNull();
    expect(sanitizeCardSpecJson(42)).toBeNull();
  });

  it("returns null when blocks is not an array", () => {
    expect(sanitizeCardSpecJson({ canvas: { w: 1080, h: 1350 }, controls: {}, blocks: {} })).toBeNull();
  });

  it("forces canvas to 1080x1350 regardless of stored values", () => {
    const spec = sanitizeCardSpecJson({ canvas: { w: 9999, h: 1 }, blocks: [], controls: { theme: "dark", brandColor: "#000", highlightColor: "#fff", bgOpacity: 50, fontFamily: "inter", textAlign: "left", logoPosition: "tr" } });
    expect(spec!.canvas).toEqual({ w: 1080, h: 1350 });
  });

  it("scrubs a malicious brandColor in controls to the default", () => {
    const spec = sanitizeCardSpecJson({ canvas: { w: 1080, h: 1350 }, blocks: [], controls: { theme: "light", brandColor: '#fff" onload=alert(1)', highlightColor: "#abc", bgOpacity: 200, fontFamily: "evil", textAlign: "diagonal", logoPosition: "xx" } });
    expect(spec!.controls.brandColor).toBe("#e11d48");
    expect(spec!.controls.bgOpacity).toBe(100); // clamped
    expect(spec!.controls.fontFamily).toBe("inter"); // enum fallback
    expect(spec!.controls.textAlign).toBe("left"); // enum fallback
    expect(spec!.controls.logoPosition).toBe("tr"); // enum fallback
  });

  it("drops a captionStack pill bg/image-url breakout via re-sanitization", () => {
    const spec = sanitizeCardSpecJson({
      canvas: { w: 1080, h: 1350 },
      controls: { theme: "light", brandColor: "#000", highlightColor: "#fff", bgOpacity: 50, fontFamily: "inter", textAlign: "left", logoPosition: "tr" },
      blocks: [
        { kind: "captionStack", props: { pills: [{ text: "hi", bg: 'red;}</style><script>', bgOpacity: -5 }] } },
        { kind: "background", props: { mode: "photo", imageUrl: "javascript:alert(1)" } },
      ],
    });
    const pill = (spec!.blocks[0] as any).props.pills[0];
    expect(pill.bg).toBe("#e11d48"); // safeColor fallback
    expect(pill.bgOpacity).toBe(0);  // clamped to [0,100]
    const bg = (spec!.blocks[1] as any).props;
    expect(bg.imageUrl).toBeUndefined(); // safeImageUrl rejected → dropped
  });

  it("sanitizes bare-string imageUrls[] elements (drops js:, keeps https)", () => {
    const spec = sanitizeCardSpecJson({
      canvas: { w: 1080, h: 1350 },
      controls: { theme: "light", brandColor: "#000", highlightColor: "#fff", bgOpacity: 50, fontFamily: "inter", textAlign: "left", logoPosition: "tr" },
      blocks: [
        { kind: "background", props: { mode: "photoGrid", imageUrls: ["javascript:alert(1)", "https://cdn.x/ok.png", 'a");}</style>'] } },
      ],
    });
    const urls = (spec!.blocks[0] as any).props.imageUrls;
    expect(urls).toEqual(["https://cdn.x/ok.png"]); // both malicious entries dropped
  });

  it("drops a block with an unknown kind", () => {
    const spec = sanitizeCardSpecJson({
      canvas: { w: 1080, h: 1350 },
      controls: { theme: "light", brandColor: "#000", highlightColor: "#fff", bgOpacity: 50, fontFamily: "inter", textAlign: "left", logoPosition: "tr" },
      blocks: [{ kind: "evil_block", props: {} }, { kind: "footer", props: { text: "Follow" } }],
    });
    expect(spec!.blocks).toHaveLength(1);
    expect((spec!.blocks[0] as any).kind).toBe("footer");
  });
});
