import { describe, it, expect, vi } from "vitest";
import type { SuperTextConfig } from "@postautomation/super-text";
import { runPerChannelSuperText, type PerChannelDeps, type PerChannelState } from "./super-text-per-channel";

const base: SuperTextConfig = {
  version: 1,
  segments: [{ text: "Wait" }, { text: "for" }, { text: "it" }],
  stripColor: "#FFFFFF",
  textColor: "#111111",
  xPct: 50,
  yPct: 72,
  fontSizePct: 4.2,
};

const targets = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    channel: { name: `Channel ${i}`, username: null, platform: i % 2 ? "FACEBOOK" : "INSTAGRAM" },
  }));

function makeDeps(over: Partial<PerChannelDeps> = {}) {
  const persisted: PerChannelState[] = [];
  const written: Array<{ targetId: string; mediaId: string; text: string; variant: number }> = [];
  const deps: PerChannelDeps = {
    loadTargets: async () => targets(4),
    generateText: vi.fn(async (prompt: string) => {
      const n = (prompt.match(/^\d+\. platform=/gm) ?? []).length;
      return JSON.stringify(Array.from({ length: n }, (_, i) => ({ index: i, text: `Variant line ${i + 1}` })));
    }),
    burn: vi.fn(async (_cfg, k) => ({ derivedMediaId: `burn-${k}` })),
    writeTargetMedia: vi.fn(async (targetId, entry) => {
      written.push({ targetId, ...entry });
    }),
    persist: vi.fn(async (s) => {
      persisted.push(JSON.parse(JSON.stringify(s)));
    }),
    log: () => undefined,
    ...over,
  };
  return { deps, persisted, written };
}

const input = (state?: PerChannelState) => ({
  sourceMediaId: "src",
  baseCfg: base,
  postContent: "caption",
  state,
});

describe("runPerChannelSuperText", () => {
  it("generates N-1 lines, burns each once, assigns round-robin with the base at 0", async () => {
    const { deps, written, persisted } = makeDeps();
    const out = await runPerChannelSuperText(deps, input());

    expect(out).toMatchObject({ targets: 4, burned: 3, unique: 3, onBase: 1, fallback: 0, degraded: false });
    expect(deps.generateText).toHaveBeenCalledTimes(1);
    expect(deps.burn).toHaveBeenCalledTimes(3);
    // The variant config carries the base styling and the new words.
    const [cfg] = (deps.burn as any).mock.calls[0];
    expect(cfg.segments.map((s: any) => s.text)).toEqual(["Variant", "line", "1"]);
    expect(cfg).toMatchObject({ stripColor: "#FFFFFF", yPct: 72 });
    // t0 keeps the shared burn; t1..t3 get variants 1..3.
    expect(written.map((w) => [w.targetId, w.mediaId, w.variant])).toEqual([
      ["t1", "burn-1", 1],
      ["t2", "burn-2", 2],
      ["t3", "burn-3", 3],
    ]);
    // Texts were persisted BEFORE the first burn.
    expect(persisted[0]!.texts).toEqual(["Variant line 1", "Variant line 2", "Variant line 3"]);
    expect(persisted[0]!.variants).toBeUndefined();
    expect(out.state.variants!["2"]).toEqual({ status: "done", text: "Variant line 2", derivedMediaId: "burn-2" });
  });

  it("a retry reuses the persisted lines and never re-burns a finished variant", async () => {
    const { deps, written } = makeDeps();
    const state: PerChannelState = {
      texts: ["A line", "B line", "C line"],
      variants: { "1": { status: "done", text: "A line", derivedMediaId: "old-1" } },
    };
    const out = await runPerChannelSuperText(deps, input(state));
    expect(deps.generateText).not.toHaveBeenCalled();
    expect((deps.burn as any).mock.calls.map((c: any[]) => c[1])).toEqual([2, 3]);
    expect(out.burned).toBe(2);
    expect(written.find((w) => w.targetId === "t1")!.mediaId).toBe("old-1");
  });

  it("a failed variant degrades its target to the shared burn and is not retried in a later run", async () => {
    const { deps, written } = makeDeps({
      burn: vi.fn(async (_cfg, k) => {
        if (k === 2) throw new Error("ffmpeg died");
        return { derivedMediaId: `burn-${k}` };
      }),
    });
    const out = await runPerChannelSuperText(deps, input());
    expect(out).toMatchObject({ burned: 2, unique: 2, onBase: 1, fallback: 1, degraded: true });
    expect(written.map((w) => w.targetId)).toEqual(["t1", "t3"]);
    expect(out.state.variants!["2"]).toEqual({ status: "failed", text: "Variant line 2" });

    const again = makeDeps();
    const rerun = await runPerChannelSuperText(again.deps, input(out.state));
    expect(again.deps.burn).not.toHaveBeenCalled();
    expect(rerun.fallback).toBe(1);
  });

  it("total generation failure: every target stays on the shared burn, marked degraded, nothing burned", async () => {
    const { deps } = makeDeps({
      generateText: vi.fn(async () => {
        throw new Error("model down");
      }),
    });
    const out = await runPerChannelSuperText(deps, input());
    expect(deps.burn).not.toHaveBeenCalled();
    expect(out).toMatchObject({ unique: 0, onBase: 1, fallback: 3, degraded: true });
    expect(out.state.generationFailed).toBe(true);
  });

  it("stops asking the model once a provider reports it is out of credit", async () => {
    const generateText = vi.fn(async () => {
      throw Object.assign(new Error("no credit"), { code: "credit_balance_exhausted" });
    });
    const { deps } = makeDeps({
      loadTargets: async () => targets(30),
      generateText,
      chunkSize: 5,
      isCreditExhausted: (e: any) => e?.code === "credit_balance_exhausted",
    });
    const out = await runPerChannelSuperText(deps, input());
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(out.state.outOfCredit).toBe(true);
    expect(out.state.generationFailed).toBe(true);
  });

  it("caps distinct variants and reuses them round-robin beyond the cap", async () => {
    const { deps, written } = makeDeps({ loadTargets: async () => targets(10), maxVariants: 4 });
    const out = await runPerChannelSuperText(deps, input());
    // cap 4 ⇒ base + 3 variants for 10 targets
    expect(deps.burn).toHaveBeenCalledTimes(3);
    expect(out.unique + out.onBase).toBe(10);
    expect(out.onBase).toBe(3); // t0, t4, t8
    expect(written.map((w) => w.variant)).toEqual([1, 2, 3, 1, 2, 3, 1]);
    expect(out.degraded).toBe(false);
  });

  it("drops duplicate / copied lines and flags the shortfall as degraded", async () => {
    const { deps } = makeDeps({
      generateText: vi.fn(async () =>
        JSON.stringify([
          { index: 0, text: "wait for it" }, // the base
          { index: 1, text: "Fresh take" },
          { index: 2, text: "FRESH take!" }, // dup
        ])
      ),
    });
    const out = await runPerChannelSuperText(deps, input());
    expect(out.state.texts).toEqual(["Fresh take"]);
    expect(deps.burn).toHaveBeenCalledTimes(1);
    // 4 targets, 1 usable variant ⇒ t0 base, t1 variant, t2 wanted its own line
    // but falls back to the shared burn, t3 variant — every target has a strip.
    expect(out).toMatchObject({ unique: 2, onBase: 1, fallback: 1, degraded: true });
  });

  it("single target: nothing to vary, nothing generated", async () => {
    const { deps } = makeDeps({ loadTargets: async () => targets(1) });
    const out = await runPerChannelSuperText(deps, input());
    expect(deps.generateText).not.toHaveBeenCalled();
    expect(out).toMatchObject({ targets: 1, onBase: 1, degraded: false });
  });
});
