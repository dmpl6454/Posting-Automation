import { describe, it, expect } from "vitest";
import { stripSourceComments } from "./source-lock";

describe("stripSourceComments", () => {
  it("strips line and block comments", () => {
    const src = `const a = 1; // trailing\n// whole line\n/** doc */\nconst b = 2;\n{/* jsx */}`;
    const out = stripSourceComments(src);
    expect(out).not.toMatch(/trailing|whole line|doc|jsx/);
    expect(out).toMatch(/const a = 1;/);
    expect(out).toMatch(/const b = 2;/);
  });

  it("does not treat a glob or a URL inside a string as a comment", () => {
    const src = `<input accept="image/*" />\nconst keep = fetch("https://x.test/a");\n/* real */ const tail = 1;`;
    const out = stripSourceComments(src);
    expect(out).toMatch(/accept="image\/\*"/);
    expect(out).toMatch(/fetch\("https:\/\/x\.test\/a"\)/);
    expect(out).toMatch(/const tail = 1;/);
    expect(out).not.toMatch(/real/);
  });
});
