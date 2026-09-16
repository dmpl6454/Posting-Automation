import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Compose's Instagram Story mode, asserted at the SOURCE level (house pattern —
 * see thumbnail-ui-contract.test.ts).
 *
 * What must not regress is that each rule EXISTS and is wired to the one shared
 * predicate. Every defect locked here is the same shape: the UI quietly promising
 * something the publish does not do, or a Post-mode control leaking into a story.
 */
const ROOT = join(__dirname, "..", "..", "..");
const compose = readFileSync(join(ROOT, "apps/web/components/content-agent/ComposeTab.tsx"), "utf8");
const storyPreviewRaw = readFileSync(
  join(ROOT, "apps/web/components/previews/instagram-story-preview.tsx"),
  "utf8"
);
/**
 * ⚠️ Comments stripped before matching: the file's own explanatory note QUOTES
 * the banned expression ("an <img> pointed at a video…"), so a raw substring test
 * fails on the documentation that exists to prevent the bug. Same treatment as
 * external-video-budget.test.ts.
 */
const storyPreview = storyPreviewRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("Story mode is one derived flag, not scattered conditions", () => {
  it("derives isStoryMode from postType", () => {
    expect(compose).toMatch(/const \[postType, setPostType\] = useState<PostType>\("post"\)/);
    expect(compose).toMatch(/const isStoryMode = postType === "story"/);
  });

  it("gates submit on ONE shared predicate feeding the handler and both buttons", () => {
    expect(compose).toMatch(/const storyBlock = isStoryMode/);
    expect(compose).toMatch(/storyBlockReason\(\{/);
    // The handler refuses, and both buttons are disabled with the same reason.
    expect(compose).toMatch(/if \(storyBlock\) \{/);
    expect(compose.match(/!!storyBlock/g) ?? []).toHaveLength(2);
    expect(compose.match(/youtubeBlockReason \?\? storyBlock \?\? undefined/g) ?? []).toHaveLength(2);
  });
});

describe("a story can only reach Instagram", () => {
  it("scopes the picker list through the shared helper", () => {
    expect(compose).toMatch(/storySelectableChannels\(\(channels as any\[\]\) \?\? \[\], postType\)/);
  });

  it("IGNORES the platform filter in story mode rather than resetting it", () => {
    // The pills that clear it are hidden; a leftover filter would empty the list
    // with no way to recover, and a reset would discard the Post-mode filter.
    expect(compose).toMatch(/filterByPlatform\(modeScoped, isStoryMode \? null : platformFilter\)/);
    expect(compose).toMatch(/if \(isStoryMode \|\| counts\.length < 2\) return null/);
  });

  it("makes a Groups pill act on Instagram members only", () => {
    expect(compose).toMatch(/activeIds: groupSelectableIds\(group, liveIds, postType\)/);
  });

  it("prunes non-Instagram picks on the mode switch AND when channels resolve", () => {
    // The switch handler cannot cover a restored draft: channels load after it.
    expect(compose).toMatch(/pruneSelectionForStory\(selectedChannels, channels as any\[\]\)/);
    expect(compose).toMatch(/pruneSelectionForStory\(reconciled, channels as any\[\]\)/);
    expect(compose).toMatch(/\}, \[channels, postType\]\)/);
  });

  it("silences the YouTube gate in story mode", () => {
    // A story cannot target YouTube, so naming it would point at a platform the
    // picker no longer shows.
    expect(compose).toMatch(/const hasYouTube = !isStoryMode && selectedPlatforms\.includes\("youtube"\)/);
  });
});

describe("Post-mode controls never leak into a story payload", () => {
  it("does not send formatByChannelId — the server forces STORY", () => {
    expect(compose).toMatch(/!isStoryMode && Object\.keys\(formatByChannelId\)\.length > 0 && \{ formatByChannelId \}/);
  });

  it("does not send uniqueCaptions or a video cover", () => {
    expect(compose).toMatch(/!isStoryMode && uniqueCaptions && selectedChannels\.length > 1/);
    // Cover branch: story metadata carries superText only.
    expect(compose).toMatch(/const md = isStoryMode/);
  });

  it("sends the story marker on the DRAFT path too", () => {
    // A draft saved without it becomes an ordinary post, and scheduling it later
    // would publish a FEED post to the account.
    expect(compose.match(/isStoryMode && \{ story: \{ mentions: storyMentions \} \}/g) ?? []).toHaveLength(2);
  });

  it("hides the cover control AND the cover it already set", () => {
    // Meta rejects cover_url on a STORIES container, so a cover shown in story
    // mode would be a promise the publish drops.
    expect(compose).toMatch(/\{isVideo && !isStoryMode && \(/);
    expect(compose).toMatch(/\{item\.thumbnail && !isStoryMode \?/);
    // The pinned thumbnail-contract literals survive — wrapped, never rewritten.
    expect(compose).toMatch(/src=\{item\.thumbnail\.url\}/);
    expect(compose).toMatch(/disabled=\{!!item\.uploading \|\| !!item\.thumbnailUploading\}/);
  });

  it("hides the carousel generator, the Post Format card and the captions card", () => {
    expect(compose).toMatch(/!hasYouTube && !hasVideoAttached && !isStoryMode/);
    expect(compose).toMatch(/!isStoryMode && \(\(hasYouTube && hasVideoAttached\)/);
    expect(compose).toMatch(/!isStoryMode && selectedChannels\.length > 1 && \(/);
  });
});

describe("mentions", () => {
  it("re-validates a restored list instead of trusting localStorage", () => {
    // One malformed username reaching post.create rejects the WHOLE post.
    expect(compose).toMatch(/sanitizeRestoredMentions\(saved\.draft\.storyMentions\)/);
  });

  it("commits on blur so a typed name is not lost by clicking Publish", () => {
    expect(compose).toMatch(/onBlur=\{commitMentionInput\}/);
  });

  it("clears mentions after a successful create, but keeps the mode", () => {
    expect(compose).toMatch(/setStoryMentions\(\[\]\);/);
    expect(compose).not.toMatch(/setPostType\("post"\);\s*\n\s*removeTask/);
  });

  it("persists postType and mentions with a STRING signature, never an array identity", () => {
    expect(compose).toMatch(/const storyMentionsSignature = storyMentions\.join\(","\)/);
    expect(compose).toMatch(/\[content, selectedChannels, draftMediaSignature, postType, storyMentionsSignature\]/);
  });
});

describe("story preview", () => {
  it("renders through PreviewMedia and never a bare tag", () => {
    // An <img> pointed at a video makes WebKit ingest the whole file.
    expect(storyPreview).toMatch(/<PreviewMedia url=\{mediaUrl\} kind=\{mediaKind\}/);
    expect(storyPreview).not.toMatch(/<img/);
    expect(storyPreview).not.toMatch(/<video/);
  });

  it("passes NO poster — covers are a Reels feature", () => {
    expect(storyPreview).not.toMatch(/poster=/);
  });

  it("classifies the tile with the shared video classifier", () => {
    expect(compose).toMatch(/isVideoMediaItem\(postMedia\[0\]\) \? "video" : "image"/);
  });

  it("replaces the switcher in story mode rather than threading a new prop through it", () => {
    expect(compose).toMatch(/\{isStoryMode \? \(/);
    expect(compose).toMatch(/<InstagramStoryPreview/);
    // The pinned switcher literal survives in the Post-mode branch.
    expect(compose).toMatch(/videoPosterUrl=\{postMedia\.find\(\(m\) => m\.thumbnail\)\?\.thumbnail\?\.url\}/);
  });
});

describe("self-review fixes", () => {
  it("never prunes the selection against an UNLOADED channel list", () => {
    // Clicking Story before channel.list resolves would otherwise wipe every
    // pick and toast that it removed them.
    expect(compose).toMatch(
      /if \(next !== "story"\) return;[\s\S]{0,400}?if \(!channels\) return;[\s\S]{0,120}?pruneSelectionForStory\(selectedChannels, channels as any\[\]\)/
    );
  });

  it("blocks a two-attachment story on the DRAFT button too", () => {
    // The server refuses it outright; the button must not offer the click.
    expect(compose).toMatch(/isStoryMode \? \(postMedia\.length === 0 && !content\) \|\| postMedia\.length > 1 : !content/);
  });

  it("does not put a fixed-size PlatformIcon inside the post-type tab", () => {
    // PlatformIcon hardcodes an h-8 w-8 container; a className override resolves
    // by stylesheet order, not string order (the competing-utilities trap).
    expect(compose).not.toMatch(/PlatformIcon platform="INSTAGRAM" size="sm"/);
  });
});

describe("diff-review fixes", () => {
  it("does NOT reset the Post-mode platform filter or captions toggle on the mode switch", () => {
    // The render already ignores both in story mode. Resetting them only
    // destroyed state — and did so or not depending on channel-query timing.
    const handler = compose.slice(
      compose.indexOf("const switchPostType ="),
      compose.indexOf("const commitMentionInput =")
    );
    expect(handler).not.toMatch(/setPlatformFilter\(/);
    expect(handler).not.toMatch(/setUniqueCaptions\(/);
  });

  it("renders the story blocker VISIBLY, not only as a title tooltip", () => {
    expect(compose).toMatch(/\{\(youtubeBlockReason \|\| storyBlock\) && \(/);
    expect(compose).toMatch(/\{youtubeBlockReason \?\? storyBlock\}/);
  });
});

describe("facebook stories (2026-09-16)", () => {
  it("no longer tells the user stories are Instagram-only", () => {
    // Comments stripped: the explanatory notes quote the very strings under test.
    const code = compose.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/Instagram channels only/);
    expect(code).toMatch(/Instagram &amp; Facebook/);
  });

  it("shows the Tag people card ONLY when an Instagram channel is selected", () => {
    // Meta's Page Stories API documents no tag parameter at all, so on a
    // Facebook-only selection the card is hidden rather than silently ignored.
    expect(compose).toMatch(/\{isStoryMode && selectedPlatforms\.includes\("instagram"\) && \(/);
  });

  it("does not promise that Instagram notifies tagged accounts", () => {
    // No Meta source supports that promise — see the 2026-09-15 investigation.
    expect(compose).not.toMatch(/Instagram notifies them/);
    expect(compose).toMatch(/has no tagging/);
  });

  it("the story preview shows the blurred fit the publish actually produces", () => {
    const previewRaw = readFileSync(
      join(__dirname, "..", "components", "previews", "instagram-story-preview.tsx"),
      "utf8"
    );
    // Comments stripped: the file's own warning note contains the banned tag.
    const preview = previewRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(preview).toMatch(/blur-xl/);
    expect(preview).toMatch(/object-contain/);
    // Both layers must go through PreviewMedia: an img tag pointed at a video
    // makes WebKit ingest the whole file and kills the tab.
    expect(preview.match(/<PreviewMedia/g)?.length).toBe(2);
    expect(preview).not.toMatch(/<img/);
  });
});
