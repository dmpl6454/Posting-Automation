import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Stub fetch with a signal-aware implementation: hangs forever unless the
// AbortSignal fires, in which case it rejects with the signal's reason —
// exactly how undici's fetch behaves on abort. This lets us prove fetchT's
// timeout actually tears the request down within budget.
const hangingFetch = vi.fn(
  (_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // hangs forever — a test using this path would time out
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })
);
vi.stubGlobal("fetch", hangingFetch);

import { fetchT, DEFAULT_CONNECT_FETCH_TIMEOUT_MS } from "../utils/fetch-timeout";

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("fetchT (connect-path fetch timeout)", () => {
  beforeEach(() => {
    hangingFetch.mockClear();
  });

  it("exports a 25s default budget", () => {
    expect(DEFAULT_CONNECT_FETCH_TIMEOUT_MS).toBe(25_000);
  });

  it("rejects a never-resolving fetch within the ms budget (TimeoutError)", async () => {
    const started = Date.now();
    await expect(fetchT("https://api.example.com/hang", {}, 25)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    // Generous ceiling — the point is it did NOT hang until a 120s proxy 504.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("attaches an AbortSignal to the underlying fetch by default", async () => {
    await fetchT("https://api.example.com/hang", {}, 20).catch(() => undefined);
    const init = hangingFetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("preserves caller-provided init fields (method/headers/body)", async () => {
    await fetchT(
      "https://api.example.com/hang",
      {
        method: "POST",
        headers: { Authorization: "Bearer tok" },
        body: "grant_type=authorization_code",
      },
      20
    ).catch(() => undefined);

    const init = hangingFetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer tok" });
    expect(init.body).toBe("grant_type=authorization_code");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps a caller-provided signal instead of replacing it with the timeout", async () => {
    const controller = new AbortController();
    const promise = fetchT("https://api.example.com/hang", { signal: controller.signal }, 20);
    // Abort with a distinctive reason — if fetchT had swapped in its own
    // timeout signal, the fetch would never see this abort.
    controller.abort(new Error("caller-abort"));
    await expect(promise).rejects.toThrow("caller-abort");

    const init = hangingFetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });
});
