import { describe, it, expect } from "vitest";

function assertOwned(ownedIds: string[], requested: string[]) {
  const ownedSet = new Set(ownedIds);
  const invalid = requested.filter((id) => !ownedSet.has(id));
  if (invalid.length) throw new Error(`Channels not in this organization: ${invalid.join(", ")}`);
}

describe("newsgrid bulkPublish channel ownership", () => {
  it("passes for owned channels", () => {
    expect(() => assertOwned(["a", "b"], ["a", "b"])).not.toThrow();
  });

  it("passes for subset of owned channels", () => {
    expect(() => assertOwned(["a", "b", "c"], ["a", "c"])).not.toThrow();
  });

  it("throws on foreign channel", () => {
    expect(() => assertOwned(["a"], ["a", "evil"])).toThrow(/evil/);
  });

  it("throws when all channels are foreign", () => {
    expect(() => assertOwned(["a", "b"], ["x", "y"])).toThrow(/Channels not in this organization/);
  });

  it("throws on empty owned set with non-empty request", () => {
    expect(() => assertOwned([], ["a"])).toThrow(/a/);
  });
});
