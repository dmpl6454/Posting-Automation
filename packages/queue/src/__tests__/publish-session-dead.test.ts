import { describe, it, expect } from "vitest";
import {
  PUBLISH_SESSION_DEAD_KEY,
  buildPublishSessionDeadRecord,
  readPublishSessionDead,
  tokenFingerprint,
  deadSessionPublishMessage,
} from "../publish-session-dead";

const TOKEN = "EAAGm0PX4ZCpsBAKZA1234567890abcdef";

describe("publish-session-dead", () => {
  it("applies to the token it was recorded on", () => {
    const meta = { igUserId: "1", [PUBLISH_SESSION_DEAD_KEY]: buildPublishSessionDeadRecord(TOKEN, "INSTAGRAM", "x") };
    expect(readPublishSessionDead(meta, TOKEN, "INSTAGRAM")).not.toBeNull();
  });

  it("is ignored once the channel holds a NEW token (a reconnect clears it)", () => {
    const meta = { [PUBLISH_SESSION_DEAD_KEY]: buildPublishSessionDeadRecord(TOKEN, "FACEBOOK", "x") };
    expect(readPublishSessionDead(meta, "EAAnewtokenafterreconnect123", "FACEBOOK")).toBeNull();
  });

  it("only applies to Facebook and Instagram", () => {
    const meta = { [PUBLISH_SESSION_DEAD_KEY]: buildPublishSessionDeadRecord(TOKEN, "FACEBOOK", "x") };
    expect(readPublishSessionDead(meta, TOKEN, "TWITTER")).toBeNull();
  });

  it("ignores missing or malformed metadata", () => {
    expect(readPublishSessionDead(null, TOKEN, "FACEBOOK")).toBeNull();
    expect(readPublishSessionDead({}, TOKEN, "FACEBOOK")).toBeNull();
    expect(readPublishSessionDead({ [PUBLISH_SESSION_DEAD_KEY]: "yes" }, TOKEN, "FACEBOOK")).toBeNull();
    expect(readPublishSessionDead({ [PUBLISH_SESSION_DEAD_KEY]: { at: "x" } }, TOKEN, "FACEBOOK")).toBeNull();
    expect(readPublishSessionDead({ [PUBLISH_SESSION_DEAD_KEY]: buildPublishSessionDeadRecord(TOKEN, "FACEBOOK", "x") }, "", "FACEBOOK")).toBeNull();
  });

  it("never stores the token itself, and filters tokens out of the reason", () => {
    const rec = buildPublishSessionDeadRecord(TOKEN, "FACEBOOK", `GET /me?access_token=${TOKEN} failed`);
    const json = JSON.stringify(rec);
    expect(json).not.toContain(TOKEN);
    expect(rec.fingerprint).toBe(tokenFingerprint(TOKEN));
    expect(rec.reason).toContain("access_token=[Filtered]");
  });

  it("says what happened and what to do", () => {
    expect(deadSessionPublishMessage("INSTAGRAM")).toMatch(/^Instagram .*Reconnect the channel/);
    expect(deadSessionPublishMessage("FACEBOOK")).toMatch(/nothing was posted/);
  });
});
