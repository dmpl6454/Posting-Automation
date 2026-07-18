import { describe, it, expect } from "vitest";
import { humanizeError } from "./errors";

describe("humanizeError (RSS-1)", () => {
  it("does not leak raw Zod-issue JSON", () => {
    const zodJson = '[{"validation":"url","code":"invalid_string","message":"Invalid url","path":["url"]}]';
    const out = humanizeError({ message: zodJson });
    expect(out).not.toContain('"validation"');
    expect(out).not.toContain("[{");
  });
  it("prefers the structured data.zodError when present", () => {
    const out = humanizeError({
      message: "[{...}]",
      data: { zodError: { fieldErrors: { url: ["Invalid url"] }, formErrors: [] } },
    });
    expect(out.toLowerCase()).toContain("url");
    expect(out).not.toContain("[{");
  });
  it("uses formErrors[0] when present", () => {
    const out = humanizeError({
      data: { zodError: { fieldErrors: {}, formErrors: ["Pick at least one channel"] } },
    });
    expect(out).toBe("Pick at least one channel");
  });
  // Regression guards — existing behavior MUST be preserved:
  it("returns a plain friendly message unchanged", () => {
    expect(humanizeError({ message: "URL does not appear to be a valid RSS or Atom feed." }))
      .toBe("URL does not appear to be a valid RSS or Atom feed.");
  });
  it("falls back for technical messages", () => {
    expect(humanizeError({ message: "TypeError: x is undefined" }))
      .toBe("Something went wrong. Please try again.");
  });
  it("falls back for empty/missing message", () => {
    expect(humanizeError({})).toBe("Something went wrong. Please try again.");
    expect(humanizeError(null)).toBe("Something went wrong. Please try again.");
  });
  it("respects a custom fallback", () => {
    expect(humanizeError({ message: "ECONNREFUSED" }, "Custom fallback"))
      .toBe("Custom fallback");
  });
  // Shared-helper edge cases (tRPC sets data.zodError = null on non-Zod errors;
  // typeof null === "object", so the truthy `zodError &&` guard MUST come first
  // or every non-Zod tRPC error would wrongly return the zod fallback string).
  it("ignores a null data.zodError and falls through to the message", () => {
    expect(
      humanizeError({ message: "Post not found", data: { zodError: null } })
    ).toBe("Post not found");
  });
  it("ignores a null data.zodError and still falls back for technical messages", () => {
    expect(
      humanizeError({ message: "TRPCError: boom", data: { zodError: null } })
    ).toBe("Something went wrong. Please try again.");
  });
});

describe("humanizeError (JSON-parse errors from HTML error pages)", () => {
  // When prod nginx serves its HTML 429/5xx page for /api/trpc, @trpc/client
  // calls res.json() on it and the raw SyntaxError message lands verbatim in
  // TRPCClientError.message — it must never reach a toast.
  it("hides the exact production JSON-parse string behind the generic fallback", () => {
    const raw = "Unexpected token '<', \"<html> <h\"... is not valid JSON";
    const out = humanizeError(new Error(raw));
    expect(out).toBe("Something went wrong. Please try again.");
    expect(out).not.toContain("Unexpected token");
    expect(out).not.toContain("not valid JSON");
  });
  it("hides other JSON-parse failure shapes (SyntaxError prefix, truncated JSON)", () => {
    expect(
      humanizeError(new Error("SyntaxError: Unexpected token < in JSON at position 0"))
    ).toBe("Something went wrong. Please try again.");
    expect(humanizeError(new Error("Unexpected end of JSON input"))).toBe(
      "Something went wrong. Please try again."
    );
  });
  it("still prefers the structured zodError message over a JSON-parse-looking message", () => {
    expect(
      humanizeError({
        message: "Unexpected token '<' ... is not valid JSON",
        data: { zodError: { fieldErrors: {}, formErrors: ["Name is required"] } },
      })
    ).toBe("Name is required");
  });
  it("passes short benign messages through unchanged", () => {
    expect(humanizeError(new Error("Channel not found"))).toBe("Channel not found");
  });
});
