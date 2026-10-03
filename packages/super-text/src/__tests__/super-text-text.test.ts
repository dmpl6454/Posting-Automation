import { describe, it, expect } from "vitest";
import { textToTokens, segmentsToText, countStripChars } from "../text";
import { buildStripInnerHtml } from "../html";
import { superTextConfigSchema, superTextSegmentSchema } from "../schema";

const base = {
  version: 1 as const,
  stripColor: "#FFFFFF",
  textColor: "#111111",
  xPct: 50,
  yPct: 84,
  fontSizePct: 4.8,
};

describe("textToTokens — manual line breaks", () => {
  it("a newline marks a break on the LAST word of the line; spaces stay word boundaries", () => {
    expect(textToTokens("Anil Kapoor exits\nAny guess?")).toEqual([
      { text: "Anil" },
      { text: "Kapoor" },
      { text: "exits", break: true },
      { text: "Any" },
      { text: "guess?" },
    ]);
  });

  it("collapses blank lines, runs of whitespace and CRLF; never a break after the last word", () => {
    expect(textToTokens("one  two\r\n\r\n  three \n")).toEqual([
      { text: "one" },
      { text: "two", break: true },
      { text: "three" },
    ]);
    expect(textToTokens("")).toEqual([]);
    expect(textToTokens(" \n ")).toEqual([]);
  });

  it("round-trips through segmentsToText so a re-opened strip shows the typed breaks", () => {
    const text = "Anil Kapoor exits from Juhu PVR\nAny guess kaun si film dekhi hogi?";
    expect(segmentsToText(textToTokens(text))).toBe(text);
    // A config with no breaks round-trips to the plain space-joined line.
    expect(segmentsToText([{ text: "Wait" }, { text: "for" }, { text: "it" }])).toBe("Wait for it");
  });

  it("countStripChars counts the words only — the cap never charges for Enter or spaces", () => {
    expect(countStripChars("ab cd\nef")).toBe(6);
    expect(countStripChars("")).toBe(0);
  });
});

describe("schema — break flag", () => {
  it("accepts break:true and nothing else on the key", () => {
    expect(superTextSegmentSchema.safeParse({ text: "x", break: true }).success).toBe(true);
    expect(superTextSegmentSchema.safeParse({ text: "x", break: false }).success).toBe(false);
    expect(superTextSegmentSchema.safeParse({ text: "x", break: "yes" }).success).toBe(false);
  });

  it("does not inject the key when absent (burn-cache hash must not shift)", () => {
    const parsed = superTextConfigSchema.parse({ ...base, segments: [{ text: "a" }, { text: "b" }] });
    expect(JSON.stringify(parsed.segments)).toBe('[{"text":"a"},{"text":"b"}]');
  });
});

describe("buildStripInnerHtml — the break renders as <br>, never as user markup", () => {
  it("joins with <br> after a breaking word and a space elsewhere", () => {
    const html = buildStripInnerHtml({
      ...base,
      segments: [{ text: "one" }, { text: "two", break: true }, { text: "three" }],
    });
    expect(html).toContain(
      `<span style="color:#111111">one</span> <span style="color:#111111">two</span><br><span style="color:#111111">three</span>`
    );
  });

  it("a config without breaks renders exactly as before (same join, no <br>)", () => {
    const html = buildStripInnerHtml({ ...base, segments: [{ text: "one" }, { text: "two" }] });
    expect(html).toContain(`<span style="color:#111111">one</span> <span style="color:#111111">two</span>`);
    expect(html).not.toContain("<br>");
  });

  it("a break on the LAST word emits nothing extra (there is no next word to separate)", () => {
    const html = buildStripInnerHtml({ ...base, segments: [{ text: "solo", break: true }] });
    expect(html).not.toContain("<br>");
  });

  it("a literal newline typed INSIDE a word is escaped text, not a break", () => {
    // The editor never produces this (it splits on whitespace), but the schema
    // allows any string; the renderer must not turn it into markup.
    const html = buildStripInnerHtml({ ...base, segments: [{ text: "a<br>b" }] });
    expect(html).toContain("a&lt;br&gt;b");
    expect(html).not.toContain("a<br>b");
  });
});
