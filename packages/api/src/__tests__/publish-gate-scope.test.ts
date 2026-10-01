import { describe, it, expect } from "vitest";
import { gatesBlockingManualPublish } from "../lib/publish-gate-scope";

const ALL = ["captionFanout", "captionFanoutHeld", "superText"];

describe("gatesBlockingManualPublish", () => {
  it("on the parked DRAFT every open gate blocks", () => {
    expect(gatesBlockingManualPublish("DRAFT", ALL)).toEqual(ALL);
  });

  it.each(["FAILED", "CANCELLED", "SCHEDULED", "PUBLISHED", "PUBLISHING"])(
    "on a %s post the caption fan-out gates are stale and ignored; super-text still blocks",
    (status) => {
      expect(gatesBlockingManualPublish(status, ALL)).toEqual(["superText"]);
      expect(gatesBlockingManualPublish(status, ["captionFanout", "captionFanoutHeld"])).toEqual([]);
    }
  );

  it("an unknown status is treated as not-DRAFT, never widening what blocks", () => {
    expect(gatesBlockingManualPublish(undefined, ["captionFanout"])).toEqual([]);
    expect(gatesBlockingManualPublish(null, ["superText"])).toEqual(["superText"]);
  });

  it("no open gates ⇒ nothing blocks", () => {
    expect(gatesBlockingManualPublish("DRAFT", [])).toEqual([]);
  });
});
