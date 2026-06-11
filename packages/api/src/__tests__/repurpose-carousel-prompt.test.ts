import { describe, it, expect } from "vitest";
import {
  slideAngleDescriptor,
  buildCarouselSlidePrompt,
  NO_REAL_PERSON_CLAUSE,
} from "../routers/repurpose.router";

// A trivial `append` mock mirroring appendImageContext's contract:
// returns base unchanged when no context, else appends a recognizable marker.
const append = (base: string, ctx?: string) => (ctx ? base + " CTX:" + ctx : base);

describe("slideAngleDescriptor", () => {
  it("returns a different angle for slide 0 vs slide 1", () => {
    expect(slideAngleDescriptor(0)).not.toBe(slideAngleDescriptor(1));
  });

  it("wraps around after the list length (idx 5 === idx 0)", () => {
    expect(slideAngleDescriptor(5)).toBe(slideAngleDescriptor(0));
  });

  it("returns a non-empty string for every slide index", () => {
    for (let i = 0; i < 12; i++) {
      expect(slideAngleDescriptor(i).length).toBeGreaterThan(0);
    }
  });
});

describe("buildCarouselSlidePrompt", () => {
  const common = {
    slideBody: "",
    totalSlides: 5,
    categoryTone: "CATEGORY: tech TONE: bold",
    imageContext: undefined as string | undefined,
  };

  it("produces a DIFFERENT angle phrase for slide 0 vs slide 1", () => {
    const p0 = buildCarouselSlidePrompt({ slideTitle: "Same Title", slideIdx: 0, ...common }, append);
    const p1 = buildCarouselSlidePrompt({ slideTitle: "Same Title", slideIdx: 1, ...common }, append);
    expect(p0).not.toBe(p1);
    expect(p0).toContain(slideAngleDescriptor(0));
    expect(p1).toContain(slideAngleDescriptor(1));
  });

  it("both slides include 'visually DISTINCT' and the 'Slide N of M' marker", () => {
    const p0 = buildCarouselSlidePrompt({ slideTitle: "T0", slideIdx: 0, ...common }, append);
    const p1 = buildCarouselSlidePrompt({ slideTitle: "T1", slideIdx: 1, ...common }, append);
    expect(p0).toContain("visually DISTINCT");
    expect(p1).toContain("visually DISTINCT");
    expect(p0).toContain("Slide 1 of 5");
    expect(p1).toContain("Slide 2 of 5");
  });

  it("includes the slide body when provided and uses the slide title (not the whole brief)", () => {
    const p = buildCarouselSlidePrompt(
      {
        slideTitle: "Quarterly results jump",
        slideBody: "Revenue rose 40% year over year.",
        slideIdx: 2,
        totalSlides: 5,
        categoryTone: "CATEGORY: finance TONE: factual",
      },
      append,
    );
    expect(p).toContain("Quarterly results jump");
    expect(p).toContain("Revenue rose 40% year over year.");
    expect(p).toContain("CATEGORY: finance");
    expect(p).toContain("TONE: factual");
    // The full SUBJECT/VISUAL brief must NOT be smuggled in via this path.
    expect(p).not.toContain("SUBJECT:");
    expect(p).not.toContain("VISUAL:");
  });

  it("omits the body clause when slideBody is empty/undefined", () => {
    const withBody = buildCarouselSlidePrompt(
      { slideTitle: "T", slideBody: "Extra detail here.", slideIdx: 0, totalSlides: 3, categoryTone: "" },
      append,
    );
    const noBody = buildCarouselSlidePrompt(
      { slideTitle: "T", slideIdx: 0, totalSlides: 3, categoryTone: "" },
      append,
    );
    expect(withBody).toContain("Extra detail here.");
    expect(noBody).not.toContain("Extra detail here.");
  });

  it("appends the imageContext through the supplied append fn", () => {
    const p = buildCarouselSlidePrompt(
      { slideTitle: "T", slideIdx: 0, totalSlides: 3, categoryTone: "", imageContext: "moody neon" },
      append,
    );
    expect(p).toContain("CTX:moody neon");
  });

  it("does not append context when imageContext is undefined", () => {
    const p = buildCarouselSlidePrompt(
      { slideTitle: "T", slideIdx: 0, totalSlides: 3, categoryTone: "" },
      append,
    );
    expect(p).not.toContain("CTX:");
  });
});

describe("NO_REAL_PERSON_CLAUSE (unconditional real-person guard)", () => {
  it("is a non-empty string mentioning real / named people", () => {
    expect(typeof NO_REAL_PERSON_CLAUSE).toBe("string");
    expect(NO_REAL_PERSON_CLAUSE.length).toBeGreaterThan(0);
    expect(NO_REAL_PERSON_CLAUSE.toLowerCase()).toContain("real");
    expect(NO_REAL_PERSON_CLAUSE.toLowerCase()).toContain("named");
  });
});
