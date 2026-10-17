import { describe, it, expect, vi, afterEach } from "vitest";
import { ensurePageSubscribed, listLinkedPages, PAGE_SUBSCRIPTION_FIELD } from "../utils/meta-page-subscription";

type Reply = { ok: boolean; status?: number; body: any } | "throw";

function mockGraph(replies: Reply[]) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: any) => {
      calls.push({ url: String(url), method: (init?.method ?? "GET").toUpperCase(), body: init?.body });
      const r = replies.shift();
      if (!r || r === "throw") throw new Error("socket hang up");
      return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 400), json: async () => r.body } as any;
    })
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const input = { pageId: "112035290218472", pageAccessToken: "PAGE_TOKEN", appId: "298449321694397" };

describe("ensurePageSubscribed", () => {
  it("leaves an existing subscription untouched (a POST would replace its fields)", async () => {
    const calls = mockGraph([{ ok: true, body: { data: [{ id: "298449321694397", subscribed_fields: ["feed"] }] } }]);
    await expect(ensurePageSubscribed(input)).resolves.toEqual({ pageId: input.pageId, status: "already" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/112035290218472/subscribed_apps?");
  });

  it("subscribes with the one quiet field when our app is absent", async () => {
    const calls = mockGraph([
      { ok: true, body: { data: [{ id: "999" }] } },
      { ok: true, body: { success: true } },
    ]);
    await expect(ensurePageSubscribed(input)).resolves.toEqual({ pageId: input.pageId, status: "subscribed" });
    expect(calls[1]!.method).toBe("POST");
    const body = new URLSearchParams(calls[1]!.body);
    expect(body.get("subscribed_fields")).toBe(PAGE_SUBSCRIPTION_FIELD);
    expect(PAGE_SUBSCRIPTION_FIELD).toBe("name");
    expect(body.get("access_token")).toBe("PAGE_TOKEN");
  });

  it("names a missing permission (on the read or the write)", async () => {
    mockGraph([{ ok: false, status: 403, body: { error: { code: 200, message: "(#200) Permissions error" } } }]);
    await expect(ensurePageSubscribed(input)).resolves.toMatchObject({ status: "missing_permission", reason: "#200" });
    mockGraph([
      { ok: true, body: { data: [] } },
      { ok: false, status: 400, body: { error: { code: 10, message: "requires pages_manage_metadata permission" } } },
    ]);
    await expect(ensurePageSubscribed(input)).resolves.toMatchObject({ status: "missing_permission" });
  });

  it("never throws, and refuses a page id that isn't a Graph id", async () => {
    mockGraph(["throw"]);
    await expect(ensurePageSubscribed(input)).resolves.toMatchObject({ status: "failed" });
    const calls = mockGraph([]);
    await expect(ensurePageSubscribed({ ...input, pageId: "1/feed" })).resolves.toMatchObject({ status: "failed" });
    expect(calls).toHaveLength(0);
  });

  it("an OK reply without success:true is a failure, not a subscription", async () => {
    mockGraph([
      { ok: true, body: { data: [] } },
      { ok: true, body: {} },
    ]);
    await expect(ensurePageSubscribed(input)).resolves.toMatchObject({ status: "failed" });
  });
});

describe("listLinkedPages", () => {
  it("returns every Page with its token and linked IG account, following paging", async () => {
    const calls = mockGraph([
      {
        ok: true,
        body: {
          data: [
            { id: "111", access_token: "T1", instagram_business_account: { id: "17841" } },
            { id: "bad id", access_token: "T" },
          ],
          paging: { next: "https://graph.facebook.com/v18.0/me/accounts?after=X" },
        },
      },
      { ok: true, body: { data: [{ id: "222", access_token: "T2" }] } },
    ]);
    await expect(listLinkedPages("USER")).resolves.toEqual({
      ok: true,
      pages: [
        { pageId: "111", pageAccessToken: "T1", igUserId: "17841" },
        { pageId: "222", pageAccessToken: "T2", igUserId: null },
      ],
    });
    expect(calls[0]!.url).toContain("/me/accounts?");
    expect(calls[0]!.url).toContain("instagram_business_account");
  });

  it("reports an unreadable listing (dead token, or a page that fails midway) as not ok", async () => {
    mockGraph([{ ok: false, status: 400, body: { error: { code: 190, error_subcode: 460 } } }]);
    await expect(listLinkedPages("USER")).resolves.toMatchObject({ ok: false, reason: "#190/460" });
    mockGraph(["throw"]);
    await expect(listLinkedPages("USER")).resolves.toMatchObject({ ok: false, reason: "request did not complete" });
  });

  it("never follows a paging link off graph.facebook.com", async () => {
    const calls = mockGraph([{ ok: true, body: { data: [], paging: { next: "https://evil.example/steal" } } }]);
    await expect(listLinkedPages("USER")).resolves.toEqual({ ok: true, pages: [] });
    expect(calls).toHaveLength(1);
  });
});
