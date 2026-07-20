/**
 * Regression tests for the browser-side multipart uploader.
 *
 * Root-caused 2026-07-20: a 3–4GB upload is 400–500 parts over 30–90 minutes;
 * the uploader had ZERO retry — a single transient network error on any part
 * aborted the entire upload. These tests lock the per-part retry contract:
 *  - transient part failures (network error / timeout) retry with a FRESH
 *    presigned URL and the upload still completes;
 *  - only exhausting all attempts aborts the multipart upload;
 *  - a user abort is NOT retried;
 *  - progress callbacks fire only on whole-percent changes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { uploadFileMultipart } from "./upload-multipart";

type Outcome =
  | { kind: "ok"; etag?: string }
  | { kind: "error" }
  | { kind: "timeout" }
  | { kind: "abort" };

/**
 * Minimal XMLHttpRequest fake. Outcomes are planned per URL (the mocked
 * signPart embeds the part number in the URL), one entry per attempt.
 */
class FakeXHR {
  static plan: Record<string, Outcome[]> = {};
  static puts: string[] = []; // URLs PUT, in order (attempts included)

  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  timeout = 0;
  status = 0;
  responseText = "";
  private url = "";
  private etag: string | null = null;
  private aborted = false;

  open(_method: string, url: string) {
    this.url = url;
  }

  getResponseHeader(_name: string): string | null {
    return this.etag;
  }

  abort() {
    this.aborted = true;
    this.onabort?.();
  }

  send(body: Blob) {
    FakeXHR.puts.push(this.url);
    const outcome = FakeXHR.plan[this.url]?.shift() ?? { kind: "ok" as const };
    queueMicrotask(() => {
      if (this.aborted) return;
      switch (outcome.kind) {
        case "error":
          this.onerror?.();
          break;
        case "timeout":
          this.ontimeout?.();
          break;
        case "abort":
          this.onabort?.();
          break;
        case "ok": {
          this.status = 200;
          this.etag = outcome.etag ?? `"etag-${this.url}"`;
          // Emit fine-grained progress (sub-percent increments) like a real
          // network upload — this is what exercises the percent throttle.
          const STEPS = 300;
          for (let i = 1; i <= STEPS; i++) {
            this.upload.onprogress?.({
              lengthComputable: true,
              loaded: Math.floor((body.size * i) / STEPS),
            });
          }
          this.onload?.();
          break;
        }
      }
    });
  }
}

function makeApi() {
  const signPartCalls: number[] = [];
  return {
    signPartCalls,
    initiate: vi.fn(async () => ({ uploadId: "up-1", key: "org/test.mp4", bucket: "b" })),
    signPart: vi.fn(async ({ partNumber }: { partNumber: number }) => {
      signPartCalls.push(partNumber);
      return { url: `part-${partNumber}` };
    }),
    complete: vi.fn(async () => ({ id: "media-1", url: "https://cdn/x.mp4", fileName: "test.mp4", fileType: "video/mp4" })),
    abort: vi.fn(async () => ({ success: true })),
  };
}

// > 8 MiB so the file splits into 2 parts (PART_SIZE = 8 MiB).
const twoPartFile = () =>
  new File([new Uint8Array(9 * 1024 * 1024)], "test.mp4", { type: "video/mp4" });

beforeEach(() => {
  FakeXHR.plan = {};
  FakeXHR.puts = [];
  (globalThis as any).XMLHttpRequest = FakeXHR;
});

describe("uploadFileMultipart retry contract", () => {
  it("uploads all parts and completes (happy path)", async () => {
    const api = makeApi();
    const result = await uploadFileMultipart({ file: twoPartFile(), api, retryBaseDelayMs: 1 });

    expect(result.id).toBe("media-1");
    expect(api.complete).toHaveBeenCalledTimes(1);
    const completed = api.complete.mock.calls[0]![0] as { parts: { partNumber: number }[] };
    expect(completed.parts.map((p) => p.partNumber).sort()).toEqual([1, 2]);
    expect(api.abort).not.toHaveBeenCalled();
  });

  it("retries a transient part failure with a fresh presigned URL and still completes", async () => {
    const api = makeApi();
    FakeXHR.plan["part-1"] = [{ kind: "error" }, { kind: "ok" }];

    const result = await uploadFileMultipart({ file: twoPartFile(), api, retryBaseDelayMs: 1 });

    expect(result.id).toBe("media-1");
    // part 1 signed twice (fresh URL per attempt), part 2 once
    expect(api.signPartCalls.filter((n) => n === 1)).toHaveLength(2);
    expect(api.signPartCalls.filter((n) => n === 2)).toHaveLength(1);
    expect(api.abort).not.toHaveBeenCalled();
  });

  it("treats a part timeout as retryable", async () => {
    const api = makeApi();
    FakeXHR.plan["part-2"] = [{ kind: "timeout" }, { kind: "ok" }];

    const result = await uploadFileMultipart({ file: twoPartFile(), api, retryBaseDelayMs: 1 });
    expect(result.id).toBe("media-1");
    expect(api.abort).not.toHaveBeenCalled();
  });

  it("aborts the multipart upload only after exhausting every attempt", async () => {
    const api = makeApi();
    FakeXHR.plan["part-1"] = [{ kind: "error" }, { kind: "error" }, { kind: "error" }, { kind: "error" }];

    await expect(
      uploadFileMultipart({ file: twoPartFile(), api, retryBaseDelayMs: 1 })
    ).rejects.toThrow();

    expect(api.signPartCalls.filter((n) => n === 1)).toHaveLength(4); // 1 + 3 retries
    expect(api.abort).toHaveBeenCalledTimes(1);
    expect(api.complete).not.toHaveBeenCalled();
  });

  it("does NOT retry a user abort", async () => {
    const api = makeApi();
    FakeXHR.plan["part-1"] = [{ kind: "abort" }];

    await expect(
      uploadFileMultipart({ file: twoPartFile(), api, retryBaseDelayMs: 1 })
    ).rejects.toThrow("Upload aborted");

    // No second signPart for part 1 — aborts are terminal.
    expect(api.signPartCalls.filter((n) => n === 1)).toHaveLength(1);
    // Multipart state is still freed server-side.
    expect(api.abort).toHaveBeenCalledTimes(1);
  });

  it("reports progress only on whole-percent changes, ending at 100", async () => {
    const api = makeApi();
    const reports: number[] = [];
    await uploadFileMultipart({
      file: twoPartFile(),
      api,
      retryBaseDelayMs: 1,
      onProgress: (p) => reports.push(p),
    });

    expect(reports[reports.length - 1]).toBe(100);
    // No consecutive duplicates — the throttle collapses repeat percents.
    for (let i = 1; i < reports.length; i++) {
      expect(reports[i]).not.toBe(reports[i - 1]);
    }
  });
});
