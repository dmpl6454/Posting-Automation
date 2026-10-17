import { describe, it, expect, vi, afterEach } from "vitest";
import { ensurePageSubscribed, PAGE_SUBSCRIPTION_FIELD } from "../utils/meta-page-subscription";

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
