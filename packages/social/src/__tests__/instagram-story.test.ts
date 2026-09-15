import { describe, it, expect } from "vitest";
import {
  isStoryFormat,
  isStoryModePost,
  readStoryMentions,
  buildStoryUserTags,
  storyPermalinkFallback,
  storyTrayUrl,
  pickStoryCandidate,
  readStoryContainerCheckpoint,
  classifyContainerStatus,
  isUserTagRejection,
  IG_USERNAME_RE,
  STORY_MAX_MENTIONS,
} from "../utils/instagram-story";

describe("isStoryFormat / isStoryModePost", () => {
  it("isStoryFormat covers BOTH routes into a story (mode + per-channel picker)", () => {
    expect(isStoryFormat({ format: "STORY" })).toBe(true);
    expect(isStoryFormat({ format: "story" })).toBe(true);
    expect(isStoryFormat({ format: "REEL" })).toBe(false);
    expect(isStoryFormat({})).toBe(false);
    expect(isStoryFormat(undefined)).toBe(false);
  });

  it("isStoryModePost is TRUE only for Compose's Story mode", () => {
    // The per-channel picker yields format STORY with no instagramStory block —
    // its multi-media behaviour (carousel) must not change.
    expect(isStoryModePost({ format: "STORY" })).toBe(false);
    expect(isStoryModePost({ instagramStory: { mentions: [] } })).toBe(true);
    expect(isStoryModePost({ instagramStory: {} })).toBe(true);
    expect(isStoryModePost({ instagramStory: [] })).toBe(false);
    expect(isStoryModePost({ instagramStory: "yes" })).toBe(false);
    expect(isStoryModePost(undefined)).toBe(false);
  });
});

describe("readStoryMentions / buildStoryUserTags", () => {
  it("returns null when there is nothing to send — the byte-identical path", () => {
    expect(buildStoryUserTags(undefined)).toBeNull();
    expect(buildStoryUserTags({})).toBeNull();
    expect(buildStoryUserTags({ instagramStory: {} })).toBeNull();
    expect(buildStoryUserTags({ instagramStory: { mentions: [] } })).toBeNull();
    expect(buildStoryUserTags({ instagramStory: { mentions: "natgeo" } })).toBeNull();
  });

  it("maps valid usernames to {username} objects, stripping a leading @", () => {
    expect(buildStoryUserTags({ instagramStory: { mentions: ["natgeo", "@nasa"] } })).toEqual([
      { username: "natgeo" },
      { username: "nasa" },
    ]);
  });

  it("drops malformed usernames (defense in depth — metadata comes from the DB)", () => {
    expect(
      readStoryMentions({
        instagramStory: {
          mentions: ["ok.user", "has space", 'quote"x', "<script>", "", "a".repeat(31), 42 as unknown as string],
        },
      })
    ).toEqual(["ok.user"]);
  });

  it("dedupes case-insensitively and caps at STORY_MAX_MENTIONS", () => {
    const many = Array.from({ length: 30 }, (_, i) => `user${i}`);
    expect(readStoryMentions({ instagramStory: { mentions: ["NatGeo", "natgeo", ...many] } })).toHaveLength(
      STORY_MAX_MENTIONS
    );
    expect(readStoryMentions({ instagramStory: { mentions: ["NatGeo", "natgeo"] } })).toEqual(["NatGeo"]);
  });

  it("IG_USERNAME_RE matches Instagram's username charset", () => {
    for (const ok of ["a", "user.name", "user_name", "USER123", "a".repeat(30)]) {
      expect(IG_USERNAME_RE.test(ok), ok).toBe(true);
    }
    for (const bad of ["", "user-name", "user name", "@user", "a".repeat(31), "user!"]) {
      expect(IG_USERNAME_RE.test(bad), bad).toBe(false);
    }
  });
});

describe("storyPermalinkFallback / storyTrayUrl", () => {
  it("builds the /stories/{username}/{id}/ URL when the username is usable", () => {
    expect(storyPermalinkFallback("nat.geo", "17900000000000000")).toBe(
      "https://www.instagram.com/stories/nat.geo/17900000000000000/"
    );
  });

  it("never emits a /p/ URL (a 404 for stories) and never interpolates junk", () => {
    expect(storyPermalinkFallback(undefined, "1")).toBe("https://www.instagram.com/");
    expect(storyPermalinkFallback("bad name", "1")).toBe("https://www.instagram.com/");
    // A usable username with an unusable id still points somewhere real.
    expect(storyPermalinkFallback("ok", 'x"y')).toBe("https://www.instagram.com/stories/ok/");
    expect(storyTrayUrl("ok")).toBe("https://www.instagram.com/stories/ok/");
    expect(storyTrayUrl(null)).toBe("https://www.instagram.com/");
  });
});

describe("pickStoryCandidate — three outcomes stay distinct", () => {
  const since = new Date("2026-09-15T10:00:00Z");
  const row = (id: string, minutesAfter: number, media_type: "IMAGE" | "VIDEO", permalink?: string) => ({
    id,
    timestamp: new Date(since.getTime() + minutesAfter * 60_000).toISOString(),
    media_type,
    ...(permalink ? { permalink } : {}),
  });

  it("adopts when exactly one story of the right kind was created inside the window", () => {
    const r = pickStoryCandidate(
      [row("s1", 1, "IMAGE", "https://www.instagram.com/stories/u/s1/"), row("old", -5, "IMAGE")],
      since,
      "IMAGE"
    );
    expect(r).toEqual({
      outcome: "match",
      story: { id: "s1", permalink: "https://www.instagram.com/stories/u/s1/" },
    });
  });

  it("ignores stories of the other media kind", () => {
    expect(pickStoryCandidate([row("v1", 1, "VIDEO")], since, "IMAGE")).toEqual({ outcome: "none" });
  });

  it("reports 'many' instead of guessing when several candidates exist", () => {
    expect(pickStoryCandidate([row("a", 1, "IMAGE"), row("b", 2, "IMAGE")], since, "IMAGE")).toEqual({
      outcome: "many",
      count: 2,
    });
  });

  it("tolerates malformed rows", () => {
    expect(
      pickStoryCandidate(
        [{ id: "x" }, { timestamp: "nope", media_type: "IMAGE", id: "y" }, null as any],
        since,
        "IMAGE"
      )
    ).toEqual({ outcome: "none" });
  });
});

describe("readStoryContainerCheckpoint", () => {
  const good = { id: "c1", createdAt: "2026-09-15T10:00:00.000Z", kind: "IMAGE" };

  it("reads a well-formed checkpoint", () => {
    expect(readStoryContainerCheckpoint({ igStoryContainer: good })).toEqual(good);
  });

  it("returns null for anything malformed rather than throwing", () => {
    for (const bad of [
      undefined,
      {},
      { igStoryContainer: null },
      { igStoryContainer: "c1" },
      { igStoryContainer: [] },
      { igStoryContainer: { ...good, id: "" } },
      { igStoryContainer: { ...good, createdAt: "not-a-date" } },
      { igStoryContainer: { ...good, kind: "CAROUSEL" } },
    ]) {
      expect(readStoryContainerCheckpoint(bad as any), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("classifyContainerStatus", () => {
  it("PUBLISHED means the story is already live — never create another", () => {
    expect(classifyContainerStatus("PUBLISHED")).toBe("published");
    expect(classifyContainerStatus("published")).toBe("published");
  });

  it("ERROR/EXPIRED are the only dispositions that permit a fresh container", () => {
    expect(classifyContainerStatus("ERROR")).toBe("dead");
    expect(classifyContainerStatus("EXPIRED")).toBe("dead");
  });

  it("an unknown or missing status is REUSABLE, never dead", () => {
    // Asymmetric on purpose: re-publishing the same creation_id cannot duplicate,
    // creating a second container can.
    for (const s of ["FINISHED", "IN_PROGRESS", "", undefined, null, 42, "SOMETHING_NEW"]) {
      expect(classifyContainerStatus(s), String(s)).toBe("reusable");
    }
  });
});

describe("isUserTagRejection", () => {
  it("recognises Meta's user-tag rejections so the operator is told which tag to drop", () => {
    expect(
      isUserTagRejection({
        error: { message: "Invalid user_tags: user natgeo does not exist or is private", code: 100 },
      })
    ).toBe(true);
    expect(
      isUserTagRejection({ error: { message: "Bad request", error_user_msg: "This username cannot be tagged." } })
    ).toBe(true);
  });

  it("does not claim a media problem is a tag problem", () => {
    expect(isUserTagRejection(undefined)).toBe(false);
    expect(isUserTagRejection({})).toBe(false);
    expect(isUserTagRejection({ error: { message: "The media is not ready to be published" } })).toBe(false);
    expect(isUserTagRejection({ error: { message: "" } })).toBe(false);
  });
});
