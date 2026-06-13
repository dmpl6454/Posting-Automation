import { describe, it, expect } from "vitest";
import { CANVAS, DEFAULT_CONTROLS, type CardSpec, type Block } from "../tools/card-engine";
import * as aiRoot from "../index";

describe("card-engine type contract", () => {
  it("exposes a fixed 1080x1350 canvas constant", () => {
    expect(CANVAS).toEqual({ w: 1080, h: 1350 });
  });

  it("provides sane default StyleControls", () => {
    expect(DEFAULT_CONTROLS.theme).toBe("light");
    expect(DEFAULT_CONTROLS.textAlign).toBe("left");
    expect(DEFAULT_CONTROLS.fontFamily).toBe("inter");
    expect(DEFAULT_CONTROLS.logoPosition).toBe("tr");
    expect(DEFAULT_CONTROLS.bgOpacity).toBe(100);
  });

  it("accepts a minimal CardSpec with a discriminated block union", () => {
    const block: Block = { kind: "footer", props: { text: "Follow @x for more" } };
    const spec: CardSpec = { canvas: CANVAS, blocks: [block], controls: DEFAULT_CONTROLS };
    expect(spec.blocks[0]!.kind).toBe("footer");
  });
});

describe("card-engine root exports", () => {
  it("re-exports renderCard, preset, legacyStyleToCardSpec from the package root", () => {
    expect(typeof aiRoot.renderCard).toBe("function");
    expect(typeof aiRoot.preset).toBe("function");
    expect(typeof aiRoot.legacyStyleToCardSpec).toBe("function");
  });
});
