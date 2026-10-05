import { describe, it, expect, vi, afterEach } from "vitest";
import { FacebookProvider } from "../providers/facebook.provider";

/**
 * Provider contract for private replies + DMs (2026-10-05) against a mocked
 * Graph: request shapes, the linked-Page lookup, and — most important — that
 * an outcome we cannot prove is reported as "may already have been sent".
 */

interface Call {
  url: string;
  method: string;
  body?: any;
}

type Reply = { ok: boolean; status?: number; body?: any; unparseable?: boolean; throws?: Error };

function mockGraph(handler: (url: string, method: string, n: number) => Reply) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: any) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), method, body });
      const r = handler(String(url), method, calls.length);
      if (r.throws) throw r.throws;
      const res: any = {
        ok: r.ok,
        status: r.status ?? (r.ok ? 200 : 400),
        json: async () => {
          if (r.unparseable) throw new SyntaxError("Unexpected token '<'");
          return r.body;
        },
        headers: { get: () => null },
      };
      res.clone = () => res;
      return res;
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const fb = () => new FacebookProvider();

describe("sendPrivateReply", () => {
  const base = { platform: "FACEBOOK" as const, pageToken: "PT", pageId: "111", senderId: "111", commentId: "222_333", text: "Hi there" };

  it("POSTs recipient.comment_id to /{sender}/messages with the token in the body", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { recipient_id: "PSID", message_id: "m_1" } }));
    const out = await fb().sendPrivateReply(base);
    expect(out).toEqual({ messageId: "m_1", recipientId: "PSID" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(new URL(calls[0]!.url).pathname).toBe("/v18.0/111/messages");
    expect(calls[0]!.url).not.toContain("PT");
    expect(calls[0]!.body).toEqual({ recipient: { comment_id: "222_333" }, message: { text: "Hi there" }, access_token: "PT" });
  });

  it("Instagram sends AS the IG account id, with the linked Page's token", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { recipient_id: "IGSID", message_id: "aWdf" } }));
    await fb().sendPrivateReply({ ...base, platform: "INSTAGRAM", senderId: "1784", commentId: "1790" });
    expect(new URL(calls[0]!.url).pathname).toBe("/v18.0/1784/messages");
  });

  it.each([
    ["a network failure", { throws: new Error("socket hang up") } as Reply],
    ["a 5xx", { ok: false, status: 502, body: { error: { code: 1 } } } as Reply],
    ["a transient 4xx", { ok: false, status: 400, body: { error: { code: 2, is_transient: true } } } as Reply],
    ["an unreadable body", { ok: false, status: 400, unparseable: true } as Reply],
    ["OK without an id", { ok: true, body: { recipient_id: "x" } } as Reply],
  ])("%s ⇒ unconfirmed, never a plain failure, and no automatic retry", async (_label, reply) => {
    const calls = mockGraph(() => reply);
    await expect(fb().sendPrivateReply(base)).rejects.toMatchObject({ failure: "unconfirmed", message: expect.stringMatching(/may already have been sent/) });
    expect(calls).toHaveLength(1);
  });

  it("a definite refusal carries its classification", async () => {
    mockGraph(() => ({ ok: false, status: 400, body: { error: { code: 10, error_subcode: 2018278, message: "(#10) This message is sent outside of allowed window." } } }));
    await expect(fb().sendPrivateReply(base)).rejects.toMatchObject({ failure: "window_closed" });
  });
});

describe("resolveInstagramPage", () => {
  it("uses the remembered Page first (one call)", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { id: "555", access_token: "PAGETOK", instagram_business_account: { id: "1784" } } }));
    expect(await fb().resolveInstagramPage("UT", "1784", "555")).toEqual({ pageId: "555", pageToken: "PAGETOK" });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe("/v18.0/555");
  });

  it("falls back to walking me/accounts when the hint no longer links", async () => {
    const calls = mockGraph((url) => {
      if (url.includes("/555?")) return { ok: true, body: { id: "555", access_token: "X", instagram_business_account: { id: "OTHER" } } };
      if (url.includes("after=2")) return { ok: true, body: { data: [{ id: "777", access_token: "T7", instagram_business_account: { id: "1784" } }] } };
      return { ok: true, body: { data: [{ id: "666", access_token: "T6" }], paging: { next: "https://graph.facebook.com/v18.0/me/accounts?after=2" } } };
    });
    expect(await fb().resolveInstagramPage("UT", "1784", "555")).toEqual({ pageId: "777", pageToken: "T7" });
    expect(calls).toHaveLength(3);
  });

  it("null when no granted Page links to the account", async () => {
    mockGraph(() => ({ ok: true, body: { data: [{ id: "1", access_token: "t", instagram_business_account: { id: "9" } }] } }));
    expect(await fb().resolveInstagramPage("UT", "1784")).toBeNull();
  });

  it("a dead user token is a token failure", async () => {
    mockGraph(() => ({ ok: false, status: 400, body: { error: { code: 190, message: "Session has expired" } } }));
    await expect(fb().resolveInstagramPage("UT", "1784")).rejects.toMatchObject({ failure: "token" });
  });

  it("a non-numeric hint is never put in a URL", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { data: [] } }));
    await fb().resolveInstagramPage("UT", "1784", "555/feed?x=");
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe("/v18.0/me/accounts");
  });
});

describe("listConversations", () => {
  it("asks for the platform's conversations and descends once on a field error", async () => {
    const calls = mockGraph((_url, _m, n) =>
      n === 1
        ? { ok: false, status: 400, body: { error: { code: 100, message: "(#100) Tried accessing nonexisting field (unread_count)" } } }
        : { ok: true, body: { data: [{ id: "aWdf1", participants: { data: [{ id: "IGSID", username: "fan" }] } }] } }
    );
    const page = await fb().listConversations({ platform: "INSTAGRAM", pageToken: "PT", pageId: "555", ownIds: ["1784", "555"] });
    expect(page.conversations[0]!.participant).toMatchObject({ id: "IGSID", username: "fan" });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe("/v18.0/555/conversations");
    expect(u.searchParams.get("platform")).toBe("instagram");
    expect(new URL(calls[1]!.url).searchParams.get("fields")).toBe("id,updated_time,participants");
  });

  it("a permission refusal is classified, not leaked as raw JSON", async () => {
    mockGraph(() => ({ ok: false, status: 403, body: { error: { code: 200, message: "(#200) Requires pages_messaging" } } }));
    await expect(
      fb().listConversations({ platform: "FACEBOOK", pageToken: "PT", pageId: "111", ownIds: ["111"] })
    ).rejects.toMatchObject({ failure: "permission", message: expect.not.stringContaining("{") });
  });
});

describe("getConversation", () => {
  it("refuses a conversation the account is not part of", async () => {
    mockGraph(() => ({ ok: true, body: { id: "t_9", participants: { data: [{ id: "A" }, { id: "B" }] }, messages: { data: [] } } }));
    await expect(
      fb().getConversation({ platform: "FACEBOOK", pageToken: "PT", pageId: "111", conversationId: "t_9", ownIds: ["111"] })
    ).rejects.toMatchObject({ failure: "not_found" });
  });

  it("encodes the client-supplied id into the path", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { id: "t_9", participants: { data: [{ id: "111" }, { id: "U" }] }, messages: { data: [] } } }));
    await fb().getConversation({ platform: "FACEBOOK", pageToken: "PT", pageId: "111", conversationId: "t_9", ownIds: ["111"] });
    expect(new URL(calls[0]!.url).pathname).toBe("/v18.0/t_9");
  });
});

describe("sendMessage", () => {
  const base = { platform: "FACEBOOK" as const, pageToken: "PT", pageId: "111", recipientId: "PSID", text: "Thanks!" };

  it("POSTs a RESPONSE message to /{page}/messages", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { recipient_id: "PSID", message_id: "m_2" } }));
    expect(await fb().sendMessage(base)).toEqual({ messageId: "m_2" });
    expect(new URL(calls[0]!.url).pathname).toBe("/v18.0/111/messages");
    expect(calls[0]!.body).toEqual({ recipient: { id: "PSID" }, messaging_type: "RESPONSE", message: { text: "Thanks!" }, access_token: "PT" });
  });

  it("an unknown outcome is unconfirmed and sent once", async () => {
    const calls = mockGraph(() => ({ ok: false, status: 503, body: null }));
    await expect(fb().sendMessage(base)).rejects.toMatchObject({ failure: "unconfirmed" });
    expect(calls).toHaveLength(1);
  });
});
