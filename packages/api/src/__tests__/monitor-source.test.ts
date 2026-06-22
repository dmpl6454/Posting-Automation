/**
 * Regression guard: every `source` string written to the ErrorLog table must be
 * a value the monitor router's filter/log enums accept — otherwise rows persist
 * but are invisible in the Monitoring UI (the auto-healer bug, 2026-06-22).
 *
 * The auto-healer worker writes `source: "auto-healer"` but the router enums
 * historically only listed frontend|api|worker|publish, so those summary rows
 * never showed under any source tab. This locks the shared enum so the two
 * sides cannot drift again.
 */
import { describe, it, expect } from "vitest";
import { ERROR_LOG_SOURCES, errorLogSourceSchema, errorLogSourceFilterSchema } from "../routers/monitor.router";

describe("ErrorLog source enum", () => {
  it("includes every source the codebase actually writes", () => {
    // These are the literal `source:` values written to prisma.errorLog across
    // the codebase (publish worker, auto-healer worker, frontend, api).
    const WRITTEN_SOURCES = ["frontend", "api", "worker", "publish", "auto-healer"];
    for (const src of WRITTEN_SOURCES) {
      expect(ERROR_LOG_SOURCES).toContain(src);
    }
  });

  it("logError accepts auto-healer as a valid source", () => {
    expect(() => errorLogSourceSchema.parse("auto-healer")).not.toThrow();
  });

  it("list filter accepts auto-healer and 'all'", () => {
    expect(() => errorLogSourceFilterSchema.parse("auto-healer")).not.toThrow();
    expect(() => errorLogSourceFilterSchema.parse("all")).not.toThrow();
  });

  it("rejects an unknown source", () => {
    expect(() => errorLogSourceSchema.parse("totally-made-up")).toThrow();
  });
});
