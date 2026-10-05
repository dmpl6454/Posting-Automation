import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { privateMessageLength, privateReplyState } from "./private-reply";
import { isUnconfirmedSend, messageLength, messagingWindowLabel, participantLabel } from "./messages";

/**
 * Private replies + Messages inbox (2026-10-05): the pure UI rules, plus
 * source-level contracts for the parts a browser test cannot see.
 */

const NOW = Date.parse("2026-10-05T12:00:00Z");
const CAPS_OK = { known: true, canPrivateReply: true, missingForPrivateReply: [] as string[] };

describe("privateReplyState", () => {
  const base = { isOwn: false, createdAt: "2026-10-04T12:00:00+0000", platform: "FACEBOOK" as const, caps: CAPS_OK, record: undefined, now: NOW };

  it("never offered on the account's own comments", () => {
    expect(privateReplyState({ ...base, isOwn: true }).show).toBe(false);
  });

  it("enabled for a fresh comment with the permission", () => {
    expect(privateReplyState(base)).toMatchObject({ show: true, disabled: false, status: "none" });
  });

  it("sent ⇒ a badge, no second message", () => {
    expect(privateReplyState({ ...base, record: { status: "SENT", at: "x" } })).toMatchObject({ disabled: true, status: "sent" });
  });

  it("unconfirmed ⇒ retry allowed with a warning (Meta refuses a duplicate)", () => {
    expect(privateReplyState({ ...base, record: { status: "UNCONFIRMED", at: "x" } })).toMatchObject({ disabled: false, status: "unconfirmed" });
  });

  it("missing permission names the scope and disables", () => {
    const s = privateReplyState({ ...base, caps: { known: true, canPrivateReply: false, missingForPrivateReply: ["pages_messaging"] } });
    expect(s.disabled).toBe(true);
    expect(s.title).toMatch(/pages_messaging/);
  });

  it("unknown grant does not block (the server decides)", () => {
    expect(privateReplyState({ ...base, caps: { known: false, canPrivateReply: null, missingForPrivateReply: [] } }).disabled).toBe(false);
  });

  it("7 days or older ⇒ disabled", () => {
    const old = privateReplyState({ ...base, createdAt: "2026-09-28T12:00:00+0000" });
    expect(old.disabled).toBe(true);
    expect(old.title).toMatch(/7 days/);
    // One second inside the window is still allowed.
    expect(privateReplyState({ ...base, createdAt: "2026-09-28T12:00:01+0000" }).disabled).toBe(false);
  });

  it("Instagram counts bytes, Facebook characters", () => {
    expect(privateMessageLength("INSTAGRAM", "é")).toEqual({ used: 2, max: 1000 });
    expect(privateMessageLength("FACEBOOK", "é")).toEqual({ used: 1, max: 2000 });
    expect(messageLength("INSTAGRAM", "ab")).toEqual({ used: 2, max: 1000, unit: "bytes" });
  });
});

describe("messagingWindowLabel", () => {
  it("open with time left", () => {
    expect(messagingWindowLabel({ windowOpen: true, windowClosesAt: "2026-10-05T15:30:00.000Z" }, NOW)).toEqual({
      tone: "open",
      text: "You can reply for 3h 30m more.",
    });
    expect(messagingWindowLabel({ windowOpen: true, windowClosesAt: "2026-10-05T12:10:00.000Z" }, NOW).text).toBe(
      "You can reply for 10 more minutes."
    );
  });
  it("closed and unknown", () => {
    expect(messagingWindowLabel({ windowOpen: false, windowClosesAt: null }, NOW).tone).toBe("closed");
    expect(messagingWindowLabel({ windowOpen: null, windowClosesAt: null }, NOW).tone).toBe("unknown");
    expect(messagingWindowLabel({ windowOpen: true, windowClosesAt: "2026-10-05T11:00:00.000Z" }, NOW).tone).toBe("closed");
  });
});

describe("labels and outcomes", () => {
  it("participantLabel", () => {
    expect(participantLabel({ name: "Asha", username: null })).toBe("Asha");
    expect(participantLabel({ name: null, username: "fan" })).toBe("@fan");
    expect(participantLabel(null)).toBe("Someone");
  });
  it("recognises the server's unconfirmed-send messages", () => {
    expect(isUnconfirmedSend("Facebook didn't confirm that message. It may already have been sent — refresh")).toBe(true);
    expect(isUnconfirmedSend("Instagram didn't confirm the private reply.")).toBe(true);
    expect(isUnconfirmedSend("You can only message someone within 24 hours")).toBe(false);
  });
});

describe("source contracts", () => {
  const thread = readFileSync(join(__dirname, "../components/messages/message-thread.tsx"), "utf8");
  const page = readFileSync(join(__dirname, "../app/dashboard/messages/page.tsx"), "utf8");
  const commentThread = readFileSync(join(__dirname, "../components/comments/comment-thread.tsx"), "utf8");
  const sidebar = readFileSync(join(__dirname, "../components/layout/sidebar.tsx"), "utf8");

  it("a send carries only the conversation — the server reads the recipient", () => {
    expect(thread).toMatch(/send\.mutate\(\{ channelId, conversationId, text \}\)/);
    expect(thread).not.toMatch(/recipientId/);
  });

  it("an <img> in a message only ever gets the image preview url", () => {
    const imgs = thread.match(/<img[^>]*>/g) ?? [];
    expect(imgs.length).toBe(1);
    expect(imgs[0]).toContain("src={a.previewUrl}");
  });

  it("an unconfirmed send never leaves a silent one-click duplicate", () => {
    expect(thread).toMatch(/isUnconfirmedSend\(err\.message\)/);
    expect(thread).toMatch(/Send again anyway/);
  });

  it("the composer is disabled when the 24-hour window is closed", () => {
    expect(thread).toMatch(/const closed = thread\?\.windowOpen === false/);
    expect(thread).toMatch(/disabled=\{closed \|\| send\.isPending/);
  });

  it("polling is bounded (thread 30s, list 60s) and refused calls aren't retried", () => {
    expect(thread).toMatch(/refetchInterval: 30_000/);
    expect(page).toMatch(/refetchInterval: 60_000/);
    expect(page).toMatch(/retry: false/);
  });

  it("the comment thread offers Reply privately through the shared rule", () => {
    expect(commentThread).toMatch(/privateReplyState\(/);
    expect(commentThread).toMatch(/trpc\.comment\.privateReply\.useMutation/);
    expect(commentThread).toMatch(/data-testid="private-reply-button"/);
  });

  it("the sidebar links the Messages inbox", () => {
    expect(sidebar).toMatch(/\{ name: "Messages", href: "\/dashboard\/messages", icon: Mail \}/);
  });
});
