import { describe, it, expect } from "vitest";
import {
  classifyMessagingError,
  isIndeterminateMessagingError,
  isMessageUnconfirmedText,
  isValidConversationId,
  messageTextTooLong,
  messageUnconfirmedMessage,
  messagingCapabilities,
  messagingFailureOf,
  MessagingError,
  parseConversationThread,
  parseConversationsPage,
  parseGraphTimestamp,
  privateReplyWindowOpen,
  utf8ByteLength,
} from "../utils/meta-messaging";

const NOW = Date.parse("2026-10-05T12:00:00Z");

describe("messagingCapabilities", () => {
  it("unknown grant ⇒ every flag null", () => {
    expect(messagingCapabilities("FACEBOOK", null)).toEqual({
      known: false,
      canPrivateReply: null,
      canUseInbox: null,
      missingForPrivateReply: [],
      missingForInbox: [],
    });
  });

  it("Facebook private reply needs pages_messaging; the inbox also needs pages_manage_metadata", () => {
    const c = messagingCapabilities("FACEBOOK", ["pages_messaging", "pages_read_engagement"]);
    expect(c.canPrivateReply).toBe(true);
    expect(c.canUseInbox).toBe(false);
    expect(c.missingForInbox).toEqual(["pages_manage_metadata"]);
  });

  it("Instagram private reply works on the already-approved comment scopes alone", () => {
    const c = messagingCapabilities("INSTAGRAM", ["instagram_basic", "instagram_manage_comments", "pages_read_engagement"]);
    expect(c.canPrivateReply).toBe(true);
    expect(c.canUseInbox).toBe(false);
    expect(c.missingForInbox).toEqual(["instagram_manage_messages", "pages_manage_metadata"]);
  });
});

describe("isValidConversationId", () => {
  it("accepts Messenger and Instagram conversation ids", () => {
    expect(isValidConversationId("t_10223456789012345")).toBe(true);
    expect(isValidConversationId("aWdfZAG06MTpJR01lc3NhZA2VUaHJlYWQ6MTc4NDE0")).toBe(true);
  });

  it("refuses path tricks and numeric node ids", () => {
    for (const bad of ["123456789", "1200847766436751_122136671235340772", "t_1/messages", "t_1?x=1", "a b", "", "abc", 5]) {
      expect(isValidConversationId(bad)).toBe(false);
    }
  });
});

describe("text limits", () => {
  it("Instagram counts UTF-8 bytes, Messenger counts characters", () => {
    expect(utf8ByteLength("é")).toBe(2);
    expect(messageTextTooLong("INSTAGRAM", "a".repeat(1000))).toBeNull();
    expect(messageTextTooLong("INSTAGRAM", "é".repeat(501))).toMatch(/1,000 bytes/);
    expect(messageTextTooLong("FACEBOOK", "é".repeat(2000))).toBeNull();
    expect(messageTextTooLong("FACEBOOK", "a".repeat(2001))).toMatch(/2,000 characters/);
  });
});

describe("parseConversationsPage", () => {
  it("names the OTHER participant, the newest snippet and who sent it", () => {
    const page = parseConversationsPage(
      {
        data: [
          {
            id: "t_1",
            updated_time: "2026-10-05T10:00:00+0000",
            unread_count: 2,
            participants: { data: [{ id: "PAGE", name: "My Page" }, { id: "PSID1", name: "Asha" }] },
            messages: { data: [{ id: "m_1", message: "hello", created_time: "2026-10-05T10:00:00+0000", from: { id: "PSID1" } }] },
          },
          {
            id: "aWdf1",
            updated_time: "2026-10-04T10:00:00+0000",
            participants: { data: [{ id: "IGSID", username: "fan" }, { id: "IG1", username: "me" }] },
            messages: { data: [{ id: "x", message: "thanks", from: { id: "IG1" } }] },
          },
          { nope: true },
        ],
        paging: { cursors: { after: "CUR" }, next: "https://graph" },
      },
      ["PAGE", "IG1"]
    );
    expect(page.nextCursor).toBe("CUR");
    expect(page.conversations).toHaveLength(2);
    expect(page.conversations[0]).toMatchObject({
      id: "t_1",
      participant: { id: "PSID1", name: "Asha", username: null },
      snippet: "hello",
      lastFromAccount: false,
      unreadCount: 2,
    });
    expect(page.conversations[1]).toMatchObject({ participant: { id: "IGSID", username: "fan" }, lastFromAccount: true, unreadCount: null });
  });

  it("no cursor without paging.next", () => {
    expect(parseConversationsPage({ data: [], paging: { cursors: { after: "X" } } }, ["P"]).nextCursor).toBeNull();
  });
});

describe("parseConversationThread — order and the 24-hour window", () => {
  const msg = (id: string, from: string, at: string, text = id) => ({ id, from: { id: from }, created_time: at, message: text });

  it("renders oldest first and opens the window from the person's last message", () => {
    const t = parseConversationThread(
      {
        id: "t_1",
        participants: { data: [{ id: "PAGE" }, { id: "U", name: "Asha" }] },
        messages: {
          data: [
            msg("m3", "PAGE", "2026-10-05T11:00:00+0000"),
            msg("m2", "U", "2026-10-05T10:00:00+0000"),
            msg("m1", "U", "2026-10-04T09:00:00+0000"),
          ],
        },
      },
      ["PAGE"],
      NOW
    );
    expect(t.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(t.messages[2]!.fromAccount).toBe(true);
    expect(t.lastInboundAt).toBe("2026-10-05T10:00:00+0000");
    expect(t.windowOpen).toBe(true);
    expect(t.windowClosesAt).toBe("2026-10-06T10:00:00.000Z");
  });

  it("closed after 24 hours", () => {
    const t = parseConversationThread(
      { id: "t", participants: { data: [] }, messages: { data: [msg("m1", "U", "2026-10-04T11:59:00+0000")] } },
      ["PAGE"],
      NOW
    );
    expect(t.windowOpen).toBe(false);
    expect(t.windowClosesAt).toBeNull();
  });

  it("only our own messages, whole conversation loaded (a private reply) ⇒ closed", () => {
    const t = parseConversationThread(
      { id: "t", messages: { data: [msg("m1", "PAGE", "2026-10-05T11:00:00+0000")] } },
      ["PAGE"],
      NOW
    );
    expect(t.windowOpen).toBe(false);
  });

  it("only our own messages at the detail limit ⇒ unknown", () => {
    const data = Array.from({ length: 20 }, (_, i) => msg(`m${i}`, "PAGE", "2026-10-05T11:00:00+0000"));
    expect(parseConversationThread({ id: "t", messages: { data } }, ["PAGE"], NOW).windowOpen).toBeNull();
  });

  it("attachments: an <img> only ever gets an image URL, and non-https is dropped", () => {
    const t = parseConversationThread(
      {
        id: "t",
        messages: {
          data: [
            {
              id: "m1",
              from: { id: "U" },
              created_time: "2026-10-05T11:00:00+0000",
              attachments: {
                data: [
                  { mime_type: "image/jpeg", image_data: { url: "https://cdn/x.jpg" } },
                  { mime_type: "video/mp4", video_data: { url: "https://cdn/v.mp4", preview_url: "https://cdn/v.jpg" } },
                  { mime_type: "image/png", image_data: { url: "javascript:alert(1)" } },
                ],
              },
              shares: { data: [{ link: "https://instagram.com/p/x" }] },
            },
          ],
        },
      },
      ["PAGE"],
      NOW
    );
    const a = t.messages[0]!.attachments;
    expect(a[0]).toMatchObject({ kind: "image", previewUrl: "https://cdn/x.jpg" });
    expect(a[1]).toMatchObject({ kind: "video", previewUrl: "https://cdn/v.jpg", url: "https://cdn/v.mp4" });
    expect(a[2]!.previewUrl).toBeNull();
    expect(a[3]).toMatchObject({ kind: "share", url: "https://instagram.com/p/x" });
  });
});

describe("timestamps and the 7-day private-reply window", () => {
  it("parses Graph's +0000 offset (Safari-safe)", () => {
    expect(parseGraphTimestamp("2026-10-05T10:00:00+0000")).toBe(Date.parse("2026-10-05T10:00:00Z"));
    expect(Number.isNaN(parseGraphTimestamp(""))).toBe(true);
  });

  it("open under 7 days, closed after, unknown without a time", () => {
    expect(privateReplyWindowOpen("2026-09-29T12:00:01+0000", NOW)).toBe(true);
    expect(privateReplyWindowOpen("2026-09-28T11:59:00+0000", NOW)).toBe(false);
    expect(privateReplyWindowOpen("", NOW)).toBeNull();
  });
});

describe("classifyMessagingError", () => {
  it("a dead token first", () => {
    expect(classifyMessagingError({ code: 190, message: "Error validating access token" })).toBe("token");
  });
  it("window closed (subcode and wording)", () => {
    expect(classifyMessagingError({ code: 10, error_subcode: 2018278, message: "(#10) This message is sent outside of allowed window." })).toBe("window_closed");
    expect(classifyMessagingError({ code: 100, error_subcode: 1545041, message: "x" })).toBe("window_closed");
  });
  it("already replied, before the #10 permission family", () => {
    expect(classifyMessagingError({ code: 10, message: "(#10) Cannot send a private reply more than once." })).toBe("already_sent");
  });
  it("person unavailable", () => {
    expect(classifyMessagingError({ code: 551, message: "This person isn't available right now." })).toBe("unavailable");
  });
  it("throttle, permission, not found, other", () => {
    expect(classifyMessagingError({ code: 613 })).toBe("throttled");
    expect(classifyMessagingError({ code: 10, message: "(#10) Requires pages_messaging permission" })).toBe("permission");
    expect(classifyMessagingError({ code: 200, message: "x" })).toBe("permission");
    expect(classifyMessagingError({ code: 100, error_subcode: 33, message: "does not exist" })).toBe("not_found");
    expect(classifyMessagingError({ code: 1, message: "unknown" })).toBe("other");
    expect(classifyMessagingError(null)).toBe("other");
  });
});

describe("unknown outcomes", () => {
  it("a 5xx or a transient 4xx is unknown; a throttle is a definite refusal", () => {
    expect(isIndeterminateMessagingError(500, { error: { code: 1 } })).toBe(true);
    expect(isIndeterminateMessagingError(400, { error: { code: 2, is_transient: true } })).toBe(true);
    expect(isIndeterminateMessagingError(400, { error: { code: 4, is_transient: true, message: "(#4) Application request limit reached" } })).toBe(false);
    expect(isIndeterminateMessagingError(400, { error: { code: 10 } })).toBe(false);
  });

  it("the unconfirmed text is recognisable and failure is read duck-typed", () => {
    expect(isMessageUnconfirmedText(messageUnconfirmedMessage("FACEBOOK", "send"))).toBe(true);
    expect(isMessageUnconfirmedText(messageUnconfirmedMessage("INSTAGRAM", "private_reply"))).toBe(true);
    expect(isMessageUnconfirmedText("Facebook couldn't send that message")).toBe(false);
    expect(messagingFailureOf(new MessagingError("x", "already_sent"))).toBe("already_sent");
    expect(messagingFailureOf({ failure: "token" })).toBe("token");
    expect(messagingFailureOf(new Error("x"))).toBeNull();
  });
});
