import { describe, it, expect } from "vitest";
import {
  buildVideoReadyDetail,
  buildVideoErrorDetail,
  friendlyVideoError,
  escapeDrawText,
  buildCaptionDrawtextFilters,
} from "./repurpose-video";

describe("buildVideoReadyDetail", () => {
  it("serializes mediaId/url/format as JSON", () => {
    expect(buildVideoReadyDetail("m1", "https://s3/x.mp4", "reel")).toBe(
      JSON.stringify({ mediaId: "m1", url: "https://s3/x.mp4", format: "reel" })
    );
  });

  it("round-trips via JSON.parse", () => {
    const detail = buildVideoReadyDetail("abc", "https://s3/y.mp4", "seedance_video");
    expect(JSON.parse(detail)).toEqual({
      mediaId: "abc",
      url: "https://s3/y.mp4",
      format: "seedance_video",
    });
  });
});

describe("buildVideoErrorDetail", () => {
  it("passes the message through unchanged", () => {
    expect(buildVideoErrorDetail("boom")).toBe("boom");
  });
});

describe("escapeDrawText", () => {
  it("escapes double-quotes for defense-in-depth (no raw \" survives)", () => {
    const out = escapeDrawText('a"b$(x)`c');
    // Every double-quote must be backslash-escaped — none may survive raw.
    expect(out).not.toMatch(/(?<!\\)"/);
    expect(out).toContain('\\"');
  });

  it("strips ASCII control characters to spaces", () => {
    const withControls = `line${String.fromCharCode(0)}one${String.fromCharCode(7)}two${String.fromCharCode(31)}`;
    const out = escapeDrawText(withControls);
    // No control char (0x00–0x1F) may remain in the output.
    expect(out).not.toMatch(/[\x00-\x1f]/);
  });

  it("keeps the existing drawtext escapes (colon / brackets)", () => {
    const out = escapeDrawText("a:b[c]d");
    expect(out).toContain("\\:");
    expect(out).toContain("\\[");
    expect(out).toContain("\\]");
  });

  it("converts single-quotes to a typographic apostrophe (existing behaviour)", () => {
    const out = escapeDrawText("it's");
    expect(out).not.toContain("'");
  });
});

describe("buildCaptionDrawtextFilters", () => {
  const enableRe = /enable='between\(t,([0-9.]+),([0-9.]+)\)'/;

  it("emits a persistent TITLE filter with NO enable= and one time-sliced filter per scene", () => {
    const filters = buildCaptionDrawtextFilters(
      { title: "My Title", scenes: ["Scene A", "Scene B"], durationSeconds: 10 },
      escapeDrawText
    );
    // title + 2 scenes
    expect(filters.length).toBe(3);
    const [title, ...scenes] = filters;
    // TITLE is persistent — no enable= expression.
    expect(title).toBeDefined();
    expect(title!).not.toContain("enable=");
    expect(title!).toContain("drawtext=");
    // every scene filter is time-sliced.
    for (const s of scenes) {
      expect(s).toMatch(enableRe);
    }
  });

  it("produces non-overlapping ascending windows that sum to ~durationSeconds", () => {
    const filters = buildCaptionDrawtextFilters(
      { title: "T", scenes: ["a", "b", "c", "d"], durationSeconds: 12 },
      escapeDrawText
    );
    const sceneFilters = filters.slice(1);
    expect(sceneFilters.length).toBe(4);
    let prevEnd = 0;
    let total = 0;
    for (const f of sceneFilters) {
      const m = f.match(enableRe);
      expect(m).not.toBeNull();
      const a = Number(m![1]);
      const b = Number(m![2]);
      // ascending, non-overlapping: this window starts where the last ended.
      expect(a).toBeCloseTo(prevEnd, 1);
      expect(b).toBeGreaterThan(a);
      total += b - a;
      prevEnd = b;
    }
    // windows tile the whole clip.
    expect(total).toBeCloseTo(12, 1);
    expect(prevEnd).toBeCloseTo(12, 1);
  });

  it("keeps the numeric between() expression INTACT — single quotes kept, commas/colons NOT escaped", () => {
    const filters = buildCaptionDrawtextFilters(
      { title: "T", scenes: ["only"], durationSeconds: 8 },
      escapeDrawText
    );
    const scene = filters[1];
    expect(scene).toBeDefined();
    // The between(...) expression keeps its single quotes (filtergraph-level).
    expect(scene!).toContain("enable='between(t,0.00,8.00)'");
    // The commas inside between(...) are NOT escaped (would break the expr).
    expect(scene!).not.toContain("between(t\\,");
    // And the t: / commas inside between are intact (no backslash-colon there).
    expect(scene!).toContain("between(t,0.00,8.00)");
  });

  it("applies escapeDrawText to the TITLE and SCENE text (single-quote/colon escaped per contract)", () => {
    const filters = buildCaptionDrawtextFilters(
      { title: "it's: A", scenes: ["b's: c"], durationSeconds: 6 },
      escapeDrawText
    );
    const title = filters[0];
    const scene = filters[1];
    expect(title).toBeDefined();
    expect(scene).toBeDefined();
    // escapeDrawText converts an apostrophe ' → typographic ’ and : → \: in the
    // TEXT, so the article apostrophe never produces a raw ASCII single quote
    // that could break out of the filtergraph `text='...'` quoting.
    // The ONLY legitimate raw single quotes are the filter-level delimiters:
    // the pair wrapping text='...' and (for scenes) the pair around between(...).
    // Extract the TEXT value between the first text='...' pair and assert the
    // article apostrophe was escaped away (no raw ' inside the text region).
    const titleText = title!.match(/text='([^']*)'/);
    expect(titleText).not.toBeNull();
    expect(titleText![1]).not.toContain("'");
    expect(title!).toContain("\\:"); // colon escaped in the title text
    const sceneText = scene!.match(/text='([^']*)'/);
    expect(sceneText).not.toBeNull();
    expect(sceneText![1]).not.toContain("'");
    expect(scene!).toContain("\\:"); // colon escaped in the scene text
    // The between(...) expression keeps its OWN single quotes (filtergraph-level).
    expect(scene!).toContain("enable='between(t,0.00,6.00)'");
  });

  it("sceneCount 0 → only the TITLE filter (no scene filters)", () => {
    const filters = buildCaptionDrawtextFilters(
      { title: "Only Title", scenes: [], durationSeconds: 10 },
      escapeDrawText
    );
    expect(filters.length).toBe(1);
    expect(filters[0]).toBeDefined();
    expect(filters[0]!).not.toContain("enable=");
  });

  it("caps at 4 scenes even when more are supplied", () => {
    const filters = buildCaptionDrawtextFilters(
      { title: "T", scenes: ["1", "2", "3", "4", "5", "6"], durationSeconds: 20 },
      escapeDrawText
    );
    // title + at most 4 scenes
    expect(filters.length).toBe(5);
  });

  it("durationSeconds <= 0 → scenes fall back to NO enable= (no broken/zero windows)", () => {
    const filters = buildCaptionDrawtextFilters(
      { title: "T", scenes: ["a", "b"], durationSeconds: 0 },
      escapeDrawText
    );
    expect(filters.length).toBe(3);
    for (const f of filters.slice(1)) {
      expect(f).not.toContain("enable=");
    }
  });

  it("empty title + empty scenes → no filters at all", () => {
    const filters = buildCaptionDrawtextFilters(
      { title: "   ", scenes: ["", "  "], durationSeconds: 10 },
      escapeDrawText
    );
    expect(filters.length).toBe(0);
  });
});

describe("friendlyVideoError", () => {
  it("returns a GENERIC safe message when no bucket matches (never leaks raw)", () => {
    const raw = "some raw provider blurb with no markers";
    const out = friendlyVideoError(raw);
    expect(out).not.toContain("raw provider blurb");
    expect(out).toBe("Video generation failed. Please try again or contact support.");
  });

  it("maps billing/dunning errors to the temporarily-unavailable message", () => {
    const out = friendlyVideoError("billing dunning decision is deny PERMISSION_DENIED");
    expect(out).toContain("temporarily unavailable");
  });

  it("maps missing-key errors to the configure message", () => {
    const out = friendlyVideoError("FAL_KEY is required");
    expect(out).toContain("not configured");
  });

  it("scrubs leaked Google project IDs / JSON to a generic provider-error message", () => {
    const out = friendlyVideoError('failed projects/518560861182 "status": 500');
    expect(out).not.toContain("518560861182");
    expect(out).toContain("provider error");
  });
});
