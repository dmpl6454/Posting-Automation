/**
 * Outbound webhook delivery POSTs to a URL an org admin typed in, and shows the
 * first 1KB of the reply on the delivery page. With plain fetch() that was a
 * reflective SSRF: the create-time check was a hostname regex (no DNS, no
 * IPv6), and fetch() followed redirects (2026-10-01). Delivery now goes
 * through userHostFetch: checked addresses only, no redirects, a deadline.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const hostFetch = vi.fn(async (..._a: any[]): Promise<Response> => new Response("ok"));
vi.mock("@postautomation/social", async () => {
  const real = await vi.importActual<typeof import("../../../../packages/social/src/utils/user-host-fetch")>(
    "../../../../packages/social/src/utils/user-host-fetch",
  );
  return { UserHostError: real.UserHostError, isUserHostError: real.isUserHostError, userHostFetch: (...a: any[]) => hostFetch(...a) };
});

const deliveryUpdate = vi.fn(async (..._a: any[]) => ({}));
vi.mock("@postautomation/db", () => ({ prisma: { webhookDelivery: { update: (...a: any[]) => deliveryUpdate(...a) } } }));
vi.mock("@postautomation/queue", () => ({ QUEUE_NAMES: { WEBHOOK_DELIVERY: "webhook-delivery" }, createRedisConnection: vi.fn() }));

const plainFetch = vi.fn(async () => {
  throw new Error("plain fetch() must not be used for a webhook endpoint");
});
vi.stubGlobal("fetch", plainFetch);

import { processWebhookDelivery } from "../workers/webhook-delivery.worker";
import { UserHostError } from "../../../../packages/social/src/utils/user-host-fetch";

const job = (url = "https://hooks.example.com/in") =>
  ({
    id: "j1",
    data: { webhookDeliveryId: "d1", webhookId: "w1", url, secret: "s", event: "post.published", payload: { a: 1 } },
  }) as any;

beforeEach(() => {
  hostFetch.mockReset();
  deliveryUpdate.mockClear();
  plainFetch.mockClear();
});

describe("processWebhookDelivery", () => {
  it("posts the signed payload through userHostFetch and records the reply", async () => {
    hostFetch.mockResolvedValueOnce(new Response("thanks", { status: 200 }));
    await expect(processWebhookDelivery(job())).resolves.toEqual({ statusCode: 200, success: true });
    const [url, init] = hostFetch.mock.calls[0]!;
    expect(url).toBe("https://hooks.example.com/in");
    expect(init).toMatchObject({ method: "POST", timeoutMs: 30_000 });
    expect(init.headers["X-Webhook-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(deliveryUpdate.mock.calls[0]![0].data).toMatchObject({ success: true, statusCode: 200, response: "thanks" });
    expect(plainFetch).not.toHaveBeenCalled();
  });

  it("an endpoint that resolves to a private address is never contacted, says why, and is not retried", async () => {
    hostFetch.mockRejectedValueOnce(new UserHostError("blocked"));
    // BullMQ stops on an UnrecoverableError (matched by name): retrying cannot help.
    await expect(processWebhookDelivery(job("https://rebind.example.com/in"))).rejects.toMatchObject({ name: "UnrecoverableError" });
    const data = deliveryUpdate.mock.calls[0]![0].data;
    expect(data).toMatchObject({ success: false, statusCode: null, response: null });
    expect(data.error).toMatch(/not a public internet address/);
  });

  it("a redirect is recorded as a failure, never followed, and not redelivered", async () => {
    // The receiver may already have handled the POST (Apps Script runs, then
    // redirects); redelivering would hand it the same event again.
    hostFetch.mockRejectedValueOnce(new UserHostError("redirect", { status: 302, requestSent: true }));
    await expect(processWebhookDelivery(job())).rejects.toMatchObject({ name: "UnrecoverableError" });
    const data = deliveryUpdate.mock.calls[0]![0].data;
    expect(data).toMatchObject({ success: false, statusCode: 302 });
    expect(data.error).toMatch(/redirect \(HTTP 302\)/);
    expect(hostFetch).toHaveBeenCalledTimes(1);
  });

  it("a 2xx with a large reply is a success (the receiver accepted the event), recorded truncated", async () => {
    hostFetch.mockResolvedValueOnce(new Response("z".repeat(5000), { status: 200 }));
    await expect(processWebhookDelivery(job())).resolves.toEqual({ statusCode: 200, success: true });
    expect(hostFetch.mock.calls[0]![1]).toMatchObject({ truncateAtCap: true });
    expect(deliveryUpdate.mock.calls[0]![0].data.response).toHaveLength(1000);
  });

  it("a non-2xx reply is a failure that keeps the endpoint's own (capped) reply for debugging", async () => {
    hostFetch.mockResolvedValueOnce(new Response("x".repeat(5000), { status: 500 }));
    await expect(processWebhookDelivery(job())).rejects.toBeTruthy();
    const data = deliveryUpdate.mock.calls[0]![0].data;
    expect(data).toMatchObject({ success: false, statusCode: 500 });
    expect(data.response).toHaveLength(1000);
    expect(data.error.length).toBeLessThanOrEqual(1000);
  });
});
