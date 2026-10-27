import { describe, it, expect } from "vitest";
import type { TikTokCreatorInfo } from "@postautomation/social/src/utils/tiktok-posting";
import {
  emptyTikTokDraft,
  tiktokSettingsFromDraft,
  tiktokBlockReason,
  buildTikTokPayload,
  sanitizeRestoredTikTok,
  pickTikTokDrafts,
  creatorStateFromQuery,
  tiktokCommercialLabel,
  tiktokConsentLine,
  tiktokPublishingLabel,
  TIKTOK_COMMERCIAL_HINT,
  type TikTokDraft,
  type TikTokCreatorState,
} from "./tiktok-post";

const creator = (over: Partial<TikTokCreatorInfo> = {}): TikTokCreatorInfo => ({
  nickname: "Dash",
  username: "dash.mani",
  avatarUrl: null,
  privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
  commentDisabled: false,
  duetDisabled: false,
  stitchDisabled: false,
  maxVideoPostDurationSec: 600,
  ...over,
});

const ready = (over: Partial<TikTokCreatorInfo> = {}): TikTokCreatorState => ({ status: "ready", info: creator(over) });

const draft = (over: Partial<TikTokDraft> = {}): TikTokDraft => ({
  ...emptyTikTokDraft(),
  privacyLevel: "PUBLIC_TO_EVERYONE",
  ...over,
});

const oneVideo = { count: 1, videoCount: 1, imageCount: 0, durationSec: 30 };
const tt = [{ id: "tt1", name: "Dash TikTok" }];

function gate(over: Partial<Parameters<typeof tiktokBlockReason>[0]> = {}) {
  return tiktokBlockReason({
    selectedTikTok: tt,
    drafts: { tt1: draft() },
    creators: { tt1: ready() },
    media: oneVideo,
    ...over,
  });
}

describe("emptyTikTokDraft", () => {
  it("has NO privacy default and every toggle OFF (TikTok's guidelines)", () => {
    expect(emptyTikTokDraft()).toEqual({
      privacyLevel: null,
      allowComment: false,
      allowDuet: false,
      allowStitch: false,
      discloseCommercial: false,
      brandOrganic: false,
      brandContent: false,
      isAigc: false,
    });
  });
  it("returns a fresh object each call (no shared mutable default)", () => {
    expect(emptyTikTokDraft()).not.toBe(emptyTikTokDraft());
  });
});

describe("tiktokSettingsFromDraft", () => {
  it("is null until a privacy level is chosen", () => {
    expect(tiktokSettingsFromDraft(emptyTikTokDraft())).toBeNull();
  });
  it("drops the brand flags when commercial disclosure is OFF", () => {
    const s = tiktokSettingsFromDraft(draft({ discloseCommercial: false, brandOrganic: true, brandContent: true }));
    expect(s).toMatchObject({ brandOrganic: false, brandContent: false });
  });
  it("keeps the brand flags when disclosure is ON", () => {
    const s = tiktokSettingsFromDraft(draft({ discloseCommercial: true, brandOrganic: true, brandContent: true }));
    expect(s).toMatchObject({ brandOrganic: true, brandContent: true });
  });
});

describe("tiktokBlockReason — nothing to gate", () => {
  it("is null without a TikTok channel, whatever the media", () => {
    expect(
      tiktokBlockReason({
        selectedTikTok: [],
        drafts: {},
        creators: {},
        media: { count: 3, videoCount: 0, imageCount: 3, durationSec: null },
      })
    ).toBeNull();
  });
  it("is null for a complete, valid post", () => {
    expect(gate()).toBeNull();
  });
});

describe("tiktokBlockReason — media", () => {
  it("needs a video", () => {
    expect(gate({ media: { count: 0, videoCount: 0, imageCount: 0, durationSec: null } })).toMatch(/needs a video/i);
  });
  it("refuses images, even beside a video", () => {
    expect(gate({ media: { count: 1, videoCount: 0, imageCount: 1, durationSec: null } })).toMatch(/video only/i);
    expect(gate({ media: { count: 2, videoCount: 1, imageCount: 1, durationSec: 30 } })).toMatch(/video only/i);
  });
  it("posts exactly one video", () => {
    expect(gate({ media: { count: 2, videoCount: 2, imageCount: 0, durationSec: 30 } })).toMatch(/one video/i);
  });
  it("media problems are reported before per-channel problems", () => {
    expect(gate({ media: { count: 0, videoCount: 0, imageCount: 0, durationSec: null }, drafts: {} })).toMatch(/needs a video/i);
  });
});

describe("tiktokBlockReason — creator info", () => {
  it("waits while the account's settings load (missing state = loading)", () => {
    expect(gate({ creators: { tt1: { status: "loading" } } })).toMatch(/Loading.*Dash TikTok/);
    expect(gate({ creators: {} })).toMatch(/Loading.*Dash TikTok/);
  });
  it("blocks with the error when the settings could not be read", () => {
    expect(gate({ creators: { tt1: { status: "error", message: "Reconnect this TikTok account." } } })).toBe(
      "Dash TikTok: Reconnect this TikTok account."
    );
    expect(gate({ creators: { tt1: { status: "error" } } })).toMatch(/^Dash TikTok: .*couldn't load/i);
  });
  it("blocks with the server's reason when the creator cannot post now", () => {
    expect(gate({ creators: { tt1: { status: "cannot-post", reason: "This account has posted too much today." } } })).toBe(
      "Dash TikTok: This account has posted too much today."
    );
    expect(gate({ creators: { tt1: { status: "cannot-post" } } })).toMatch(/can't post right now/i);
  });
});

describe("tiktokBlockReason — settings", () => {
  it("requires a privacy choice (no default)", () => {
    expect(gate({ drafts: { tt1: emptyTikTokDraft() } })).toBe("Dash TikTok: choose who can see this video.");
    expect(gate({ drafts: {} })).toBe("Dash TikTok: choose who can see this video.");
  });
  it("requires the privacy level to be one of the creator's options", () => {
    expect(gate({ drafts: { tt1: draft({ privacyLevel: "FOLLOWER_OF_CREATOR" }) } })).toMatch(/can't post with "Followers"/);
  });
  it("commercial disclosure ON needs Your brand and/or Branded content", () => {
    expect(gate({ drafts: { tt1: draft({ discloseCommercial: true }) } })).toBe(`Dash TikTok: ${TIKTOK_COMMERCIAL_HINT}`);
    expect(gate({ drafts: { tt1: draft({ discloseCommercial: true, brandOrganic: true }) } })).toBeNull();
    expect(gate({ drafts: { tt1: draft({ discloseCommercial: true, brandContent: true }) } })).toBeNull();
  });
  it("branded content cannot be Only me", () => {
    expect(
      gate({ drafts: { tt1: draft({ privacyLevel: "SELF_ONLY", discloseCommercial: true, brandContent: true }) } })
    ).toMatch(/Branded content can't be private/);
    // Disclosure OFF: the stale brandContent flag is ignored, Only me is fine.
    expect(gate({ drafts: { tt1: draft({ privacyLevel: "SELF_ONLY", brandContent: true }) } })).toBeNull();
  });
  it("interactions can be allowed only when the creator allows them", () => {
    expect(gate({ drafts: { tt1: draft({ allowComment: true }) }, creators: { tt1: ready({ commentDisabled: true }) } })).toMatch(
      /comments turned off/
    );
    expect(gate({ drafts: { tt1: draft({ allowDuet: true }) }, creators: { tt1: ready({ duetDisabled: true }) } })).toMatch(/Duet/);
    expect(gate({ drafts: { tt1: draft({ allowStitch: true }) }, creators: { tt1: ready({ stitchDisabled: true }) } })).toMatch(/Stitch/);
    // Off is always fine, and on is fine when the creator allows it.
    expect(gate({ drafts: { tt1: draft() }, creators: { tt1: ready({ commentDisabled: true, duetDisabled: true, stitchDisabled: true }) } })).toBeNull();
    expect(gate({ drafts: { tt1: draft({ allowComment: true, allowDuet: true, allowStitch: true }) } })).toBeNull();
  });
  it("the video must not exceed the creator's max duration", () => {
    expect(gate({ media: { ...oneVideo, durationSec: 601 }, creators: { tt1: ready({ maxVideoPostDurationSec: 600 }) } })).toMatch(
      /up to 600s/
    );
    expect(gate({ media: { ...oneVideo, durationSec: 600 }, creators: { tt1: ready({ maxVideoPostDurationSec: 600 }) } })).toBeNull();
    // Unknown duration or unknown max: not blocked here (the server re-checks).
    expect(gate({ media: { ...oneVideo, durationSec: null } })).toBeNull();
    expect(gate({ media: { ...oneVideo, durationSec: 9999 }, creators: { tt1: ready({ maxVideoPostDurationSec: null }) } })).toBeNull();
  });
  it("a caption over TikTok's 2,200 limit is reported per channel when lengths are given", () => {
    expect(gate({ captionLengths: { tt1: 2201 } })).toMatch(/2,200/);
    expect(gate({ captionLengths: { tt1: 2200 } })).toBeNull();
    expect(gate({ captionLengths: {} })).toBeNull();
  });
  it("checks EVERY selected TikTok channel and names the one that is not ready", () => {
    const r = tiktokBlockReason({
      selectedTikTok: [
        { id: "tt1", name: "First" },
        { id: "tt2", name: "Second" },
      ],
      drafts: { tt1: draft(), tt2: emptyTikTokDraft() },
      creators: { tt1: ready(), tt2: ready() },
      media: oneVideo,
    });
    expect(r).toBe("Second: choose who can see this video.");
  });
});

describe("buildTikTokPayload", () => {
  it("is null when no selected TikTok channel has a privacy choice", () => {
    expect(buildTikTokPayload({}, [])).toBeNull();
    expect(buildTikTokPayload({ tt1: emptyTikTokDraft() }, ["tt1"])).toBeNull();
  });
  it("sends only STILL-selected channels (the draft map is never pruned)", () => {
    const out = buildTikTokPayload({ tt1: draft(), gone: draft() }, ["tt1"]);
    expect(Object.keys(out!.byChannel)).toEqual(["tt1"]);
  });
  it("maps the draft to the server settings contract exactly", () => {
    const out = buildTikTokPayload(
      { tt1: draft({ privacyLevel: "SELF_ONLY", allowComment: true, isAigc: true, discloseCommercial: true, brandOrganic: true }) },
      ["tt1"]
    );
    expect(out).toEqual({
      byChannel: {
        tt1: {
          privacyLevel: "SELF_ONLY",
          allowComment: true,
          allowDuet: false,
          allowStitch: false,
          brandOrganic: true,
          brandContent: false,
          isAigc: true,
        },
      },
    });
  });
  it("never sends brand flags when disclosure is off", () => {
    const out = buildTikTokPayload({ tt1: draft({ brandOrganic: true, brandContent: true }) }, ["tt1"]);
    expect(out!.byChannel.tt1).toMatchObject({ brandOrganic: false, brandContent: false });
  });
});

describe("sanitizeRestoredTikTok", () => {
  it("returns {} for anything that is not a plain object", () => {
    for (const raw of [undefined, null, "x", 3, [], [draft()]]) expect(sanitizeRestoredTikTok(raw)).toEqual({});
  });
  it("keeps valid entries field by field", () => {
    const d = draft({ allowDuet: true, discloseCommercial: true, brandContent: true });
    expect(sanitizeRestoredTikTok({ tt1: d })).toEqual({ tt1: d });
  });
  it("an unknown privacy level becomes 'not chosen', never a guess", () => {
    expect(sanitizeRestoredTikTok({ tt1: { privacyLevel: "EVERYONE" } }).tt1!.privacyLevel).toBeNull();
  });
  it("only a literal true counts as true", () => {
    const out = sanitizeRestoredTikTok({ tt1: { privacyLevel: "SELF_ONLY", allowComment: "true", allowDuet: 1, isAigc: true } });
    expect(out.tt1).toEqual({ ...emptyTikTokDraft(), privacyLevel: "SELF_ONLY", isAigc: true });
  });
  it("drops non-object entries, odd keys and prototype keys", () => {
    const raw = JSON.parse('{"__proto__":{"privacyLevel":"SELF_ONLY"},"ok":{"privacyLevel":"SELF_ONLY"},"bad key!":{},"n":5}');
    const out = sanitizeRestoredTikTok(raw);
    expect(Object.keys(out)).toEqual(["ok"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).privacyLevel).toBeUndefined();
  });
});

describe("pickTikTokDrafts", () => {
  it("keeps only the given channel ids", () => {
    expect(pickTikTokDrafts({ a: draft(), b: draft() }, ["b", "zzz"])).toEqual({ b: draft() });
  });
});

describe("creatorStateFromQuery", () => {
  it("pending ⇒ loading", () => {
    expect(creatorStateFromQuery({ isPending: true })).toEqual({ status: "loading" });
  });
  it("error ⇒ error with the message", () => {
    expect(creatorStateFromQuery({ isPending: false, errorMessage: "Reconnect" })).toEqual({ status: "error", message: "Reconnect" });
  });
  it("canPost false ⇒ cannot-post with the server's reason", () => {
    expect(
      creatorStateFromQuery({ isPending: false, data: { creator: creator(), canPost: false, reason: "Try later." } })
    ).toEqual({ status: "cannot-post", reason: "Try later." });
  });
  it("canPost true with a creator ⇒ ready; without one ⇒ error", () => {
    expect(creatorStateFromQuery({ isPending: false, data: { creator: creator(), canPost: true, reason: null } })).toEqual(ready());
    expect(creatorStateFromQuery({ isPending: false, data: { creator: null, canPost: true, reason: null } }).status).toBe("error");
  });
});

describe("labels", () => {
  it("commercial label follows TikTok's wording", () => {
    expect(tiktokCommercialLabel(draft())).toBeNull();
    expect(tiktokCommercialLabel(draft({ discloseCommercial: true }))).toBeNull();
    expect(tiktokCommercialLabel(draft({ discloseCommercial: true, brandOrganic: true }))).toBe(
      "Your video will be labeled as 'Promotional content'"
    );
    expect(tiktokCommercialLabel(draft({ discloseCommercial: true, brandContent: true }))).toBe(
      "Your video will be labeled as 'Paid partnership'"
    );
    expect(tiktokCommercialLabel(draft({ discloseCommercial: true, brandOrganic: true, brandContent: true }))).toBe(
      "Your video will be labeled as 'Paid partnership'"
    );
  });
  it("consent line: null without TikTok, branded wording when any selected channel is branded content", () => {
    expect(tiktokConsentLine({}, [])).toBeNull();
    expect(tiktokConsentLine({ tt1: draft() }, ["tt1"])).toBe("By posting, you agree to TikTok's Music Usage Confirmation.");
    expect(tiktokConsentLine({}, ["tt1"])).toBe("By posting, you agree to TikTok's Music Usage Confirmation.");
    expect(
      tiktokConsentLine({ tt1: draft(), tt2: draft({ discloseCommercial: true, brandContent: true }) }, ["tt1", "tt2"])
    ).toBe("By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation.");
    // A deselected channel's branded flag does not change the line.
    expect(tiktokConsentLine({ tt2: draft({ discloseCommercial: true, brandContent: true }) }, ["tt1"])).toMatch(/^By posting, you agree to TikTok's Music/);
  });
});

describe("tiktokPublishingLabel (post page, PUBLISHING target)", () => {
  it("no known percent ⇒ TikTok is processing", () => {
    expect(tiktokPublishingLabel(null)).toBe("Processing on TikTok…");
    expect(tiktokPublishingLabel(undefined)).toBe("Processing on TikTok…");
  });
  it("transfer under way ⇒ uploading; finished transfer ⇒ processing", () => {
    expect(tiktokPublishingLabel(0)).toBe("Uploading…");
    expect(tiktokPublishingLabel(42)).toBe("Uploading…");
    expect(tiktokPublishingLabel(100)).toBe("Processing on TikTok…");
  });
});
