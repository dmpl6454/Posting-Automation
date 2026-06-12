import { describe, it, expect } from "vitest";

// Minimal harness: assert the helper rejects foreign channel ids.
function assertChannelsOwned(ownedIds: string[], requested: string[]) {
  const ownedSet = new Set(ownedIds);
  const invalid = requested.filter((id) => !ownedSet.has(id));
  if (invalid.length) throw new Error(`Channels not in this organization: ${invalid.join(", ")}`);
}

describe("rss channel ownership", () => {
  it("passes when all channels are owned", () => {
    expect(() => assertChannelsOwned(["a", "b"], ["a"])).not.toThrow();
  });
  it("throws on a foreign channel id", () => {
    expect(() => assertChannelsOwned(["a"], ["a", "x"])).toThrow(/x/);
  });
});
