import { describe, it, expect } from "vitest";
import { windowChannels, CHANNEL_RENDER_WINDOW } from "./channel-list-window";

const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}` }));

describe("windowChannels", () => {
  it("renders everything when under the window (no regression for small orgs)", () => {
    const list = mk(5);
    const { visible, hiddenCount } = windowChannels(list, false);
    expect(visible).toHaveLength(5);
    expect(hiddenCount).toBe(0);
  });

  it("caps to CHANNEL_RENDER_WINDOW on first paint for a large list (the fix)", () => {
    const list = mk(387); // the real 387-FB-channel org
    const { visible, hiddenCount } = windowChannels(list, false);
    expect(visible).toHaveLength(CHANNEL_RENDER_WINDOW);
    expect(hiddenCount).toBe(387 - CHANNEL_RENDER_WINDOW);
  });

  it("renders all when showAll is true", () => {
    const list = mk(387);
    const { visible, hiddenCount } = windowChannels(list, true);
    expect(visible).toHaveLength(387);
    expect(hiddenCount).toBe(0);
  });

  it("keeps selected channels beyond the window visible (bulk-action safety)", () => {
    const list = mk(100);
    const selected = new Set(["c0", "c50", "c99"]); // c50, c99 are beyond the window
    const { visible } = windowChannels(list, false, selected);
    const ids = new Set(visible.map((c) => c.id));
    expect(ids.has("c50")).toBe(true);
    expect(ids.has("c99")).toBe(true);
    expect(visible.length).toBe(CHANNEL_RENDER_WINDOW + 2); // window + the 2 out-of-window selected
  });

  it("does not duplicate a selected channel that is already within the window", () => {
    const list = mk(100);
    const selected = new Set(["c0", "c1"]); // both within window
    const { visible } = windowChannels(list, false, selected);
    expect(visible).toHaveLength(CHANNEL_RENDER_WINDOW);
    expect(new Set(visible.map((c) => c.id)).size).toBe(CHANNEL_RENDER_WINDOW);
  });
});
