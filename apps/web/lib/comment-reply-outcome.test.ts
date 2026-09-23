import { describe, it, expect } from "vitest";
import { classifyReplyFailure } from "./comment-reply-outcome";

describe("classifyReplyFailure", () => {
  it("trusts the provider's 'may already be posted' verdict", () => {
    expect(
      classifyReplyFailure({
        message: "Facebook accepted the reply but did not confirm it. Refresh the comments before replying again — it may already be posted.",
        data: { code: "BAD_REQUEST", httpStatus: 400 },
      })
    ).toBe("unconfirmed");
  });

  it("treats a transport failure of OUR call (no tRPC envelope) as unknown — the server may have finished the POST", () => {
    expect(classifyReplyFailure({ message: "Failed to fetch" })).toBe("unconfirmed");
    expect(classifyReplyFailure({ message: "The server returned an unexpected response. Please try again." })).toBe(
      "unconfirmed"
    );
  });

  it("treats a 5xx from our own server as unknown", () => {
    expect(classifyReplyFailure({ message: "Internal server error", data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 } })).toBe(
      "unconfirmed"
    );
  });

  it("treats rate limits as refusals — the request never reached Meta", () => {
    expect(classifyReplyFailure({ message: "Rate limit exceeded", data: { code: "TOO_MANY_REQUESTS", httpStatus: 429 } })).toBe(
      "refused"
    );
    // nginx's HTML 429, remapped by guardedFetch (no envelope)
    expect(classifyReplyFailure({ message: "Too many requests - please wait a moment and try again." })).toBe("refused");
  });

  it("treats a structured 4xx (permission, gone, validation, throttle) as a refusal", () => {
    for (const code of ["BAD_REQUEST", "NOT_FOUND", "FORBIDDEN"]) {
      expect(classifyReplyFailure({ message: "This Facebook Page hasn't granted comment access yet.", data: { code, httpStatus: 400 } })).toBe(
        "refused"
      );
    }
  });
});
