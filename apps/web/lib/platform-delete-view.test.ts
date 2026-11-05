import { describe, it, expect } from "vitest";
import {
  targetDeleteState,
  canRequestDelete,
  postDeleteSummary,
  targetDeleteLine,
  deleteRequestToast,
} from "./platform-delete-view";

const NOW = new Date("2026-11-05T10:00:00.000Z");
const t = (o: any = {}) => ({ status: "PUBLISHED", publishedId: "1", platformDeletedAt: null, metadata: null, channel: { platform: "INSTAGRAM" }, ...o });

describe("targetDeleteState", () => {
  it("only published Facebook/Instagram targets are deletable", () => {
    expect(targetDeleteState(t(), NOW).kind).toBe("eligible");
    expect(targetDeleteState(t({ channel: { platform: "FACEBOOK" } }), NOW).kind).toBe("eligible");
    expect(targetDeleteState(t({ channel: { platform: "TIKTOK" } }), NOW).kind).toBe("none");
    expect(targetDeleteState(t({ status: "FAILED" }), NOW).kind).toBe("none");
    expect(targetDeleteState(t({ publishedId: null }), NOW).kind).toBe("none");
  });

  it("in progress only while the request is fresh; a lost request may be asked again", () => {
    const fresh = t({ metadata: { platformDelete: { status: "deleting", requestedAt: "2026-11-05T09:55:00.000Z" } } });
    expect(targetDeleteState(fresh, NOW).kind).toBe("in_progress");
    const lost = t({ metadata: { platformDelete: { status: "queued", requestedAt: "2026-11-05T08:00:00.000Z" } } });
    expect(targetDeleteState(lost, NOW).kind).toBe("eligible");
  });

  it("deleted wins over everything; failures and not-found can be retried", () => {
    expect(targetDeleteState(t({ platformDeletedAt: "2026-11-05T09:00:00.000Z" }), NOW)).toEqual({ kind: "deleted", at: "2026-11-05T09:00:00.000Z" });
    const failed = targetDeleteState(t({ metadata: { platformDelete: { status: "failed", message: "Reconnect" } } }), NOW);
    expect(failed).toEqual({ kind: "failed", message: "Reconnect" });
    expect(canRequestDelete(failed)).toBe(true);
    expect(canRequestDelete({ kind: "in_progress" })).toBe(false);
    expect(canRequestDelete({ kind: "deleted", at: null })).toBe(false);
  });
});

describe("postDeleteSummary", () => {
  it("counts per state and names only the platforms that can be deleted", () => {
    const s = postDeleteSummary(
      [
        t(),
        t({ channel: { platform: "INSTAGRAM" }, platformDeletedAt: "2026-11-05T09:00:00.000Z" }),
        t({ channel: { platform: "TWITTER" } }),
        t({ channel: { platform: "FACEBOOK" }, metadata: { platformDelete: { status: "queued", requestedAt: "2026-11-05T09:59:00.000Z" } } }),
      ],
      NOW
    );
    expect(s).toEqual({ requestable: 1, inProgress: 1, deleted: 1, platformsLabel: "Instagram" });
  });
});

describe("wording", () => {
  it("lines say what happened and never 'failed' for a not-found", () => {
    expect(targetDeleteLine({ kind: "in_progress" }, "FACEBOOK")?.text).toBe("Deleting from Facebook…");
    expect(targetDeleteLine({ kind: "not_found", message: "" }, "INSTAGRAM")?.tone).toBe("warn");
    expect(targetDeleteLine({ kind: "eligible" }, "INSTAGRAM")).toBeNull();
  });

  it("the request toast names what was skipped", () => {
    const q = deleteRequestToast({ queued: 3, notPublished: 1, unsupported: 2, alreadyDeleted: 0, inProgress: 0, overLimit: 0 });
    expect(q.title).toBe("Deleting 3 posts from the platforms");
    expect(q.description).toContain("2 on platforms we can't delete from");
    expect(deleteRequestToast({ queued: 0, notPublished: 2, unsupported: 0, alreadyDeleted: 0, inProgress: 0, overLimit: 0 }).title).toBe("Nothing to delete");
  });
});
