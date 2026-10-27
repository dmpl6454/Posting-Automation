import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripSourceComments } from "./source-lock";

/**
 * Compose's TikTok posting card (2026-10-28), asserted at the SOURCE level
 * (house pattern — see story-ui-contract.test.ts / article-ui-contract.test.ts).
 * Each rule locks a way the UI could post to TikTok without the user's choices,
 * break TikTok's Content Sharing Guidelines, or regress the OOM dep rule.
 */
const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => stripSourceComments(readFileSync(join(ROOT, p), "utf8"));
const compose = read("apps/web/components/content-agent/ComposeTab.tsx");
const card = read("apps/web/components/content-agent/TikTokPostSettings.tsx");
const lib = read("apps/web/lib/tiktok-post.ts");
const postPage = read("apps/web/app/dashboard/posts/[id]/page.tsx");

describe("what a post to TikTok sends", () => {
  it("BOTH create paths (publish/schedule and save-as-draft) carry the TikTok settings", () => {
    expect(compose.match(/\.\.\.tiktokPayload\(\),/g) ?? []).toHaveLength(2);
    expect(compose).toMatch(
      /function tiktokPayload\(\)[\s\S]{0,200}if \(isStoryMode \|\| isArticleMode\) return \{\};\s*const tiktok = buildTikTokPayload\(tiktokDrafts, selectedTikTokIds\);/
    );
  });
  it("TikTok channels are derived from the live selection, in Post mode only", () => {
    expect(compose).toMatch(
      /const selectedTikTokChannels[\s\S]{0,120}!isStoryMode && !isArticleMode\s*\?[\s\S]{0,160}ch\.platform === "TIKTOK" && selectedChannels\.includes\(ch\.id\)/
    );
  });
});

describe("the card", () => {
  it("renders only in Post mode with a TikTok channel, after the Post Format card and before Schedule", () => {
    expect(compose).toMatch(
      /\{!isStoryMode && !isArticleMode && selectedTikTokChannels\.length > 0 && \(\s*<TikTokPostSettings/
    );
    const format = compose.indexOf("<CardTitle>Post Format</CardTitle>");
    const tiktok = compose.indexOf("<TikTokPostSettings");
    const schedule = compose.indexOf('data-testid="compose-schedule-card"');
    expect(format).toBeGreaterThan(-1);
    expect(tiktok).toBeGreaterThan(format);
    expect(schedule).toBeGreaterThan(tiktok);
  });
  it("one creator_info query per channel, cached 60 s, never retried", () => {
    expect(card).toMatch(/trpc\.useQueries\(/);
    expect(card).toMatch(/t\.tiktok\.creatorInfo\(\{ channelId \}, \{ staleTime: CREATOR_INFO_STALE_MS, retry: false \}\)/);
    expect(card).toMatch(/const CREATOR_INFO_STALE_MS = 60_000;/);
  });
  it("privacy: exactly the creator's options, NO default, placeholder from the guideline", () => {
    expect(card).toMatch(/<SelectValue placeholder=\{TIKTOK_PRIVACY_PLACEHOLDER\} \/>/);
    expect(lib).toMatch(/TIKTOK_PRIVACY_PLACEHOLDER = "Who can see this video"/);
    expect(card).toMatch(/info\.privacyLevelOptions\.map\(\(level\)/);
    expect(card).not.toMatch(/defaultValue/);
  });
  it("branded content disables Only me with the guideline's text", () => {
    expect(card).toMatch(/const blocked = level === "SELF_ONLY" && brandedOn;/);
    expect(card).toMatch(/<SelectItem key=\{level\} value=\{level\} disabled=\{blocked\}>/);
    expect(lib).toMatch(/TIKTOK_BRANDED_PRIVATE_TEXT = "Branded content visibility cannot be set to private\."/);
  });
  it("Comment/Duet/Stitch grey out with a VISIBLE reason when the creator turned them off", () => {
    expect(card).toMatch(/const disabled = off && !checked;/);
    expect(card).toMatch(/\{off \? <span[^>]*>\{TIKTOK_INTERACTION_OFF_TEXT\}<\/span> : null\}/);
  });
  it("commercial disclosure reveals Your brand / Branded content, the hint and the label", () => {
    expect(card).toMatch(/Disclose commercial content/);
    expect(card).toMatch(/\{draft\.discloseCommercial \? \(/);
    expect(card).toMatch(/Your brand/);
    expect(card).toMatch(/Branded content/);
    expect(card).toMatch(/\{TIKTOK_COMMERCIAL_HINT\}/);
    expect(card).toMatch(/const commercialLabel = tiktokCommercialLabel\(draft\);/);
    expect(card).toMatch(/AI-generated content/);
  });
  it("shows the creator's nickname and @username", () => {
    expect(card).toMatch(/const displayName = info\?\.nickname \|\| channel\.name;/);
    expect(card).toMatch(/@\{info\.username\}/);
  });
  it("imports the contract by deep path, never the social index (server code)", () => {
    for (const src of [card, lib]) {
      expect(src).toMatch(/from "@postautomation\/social\/src\/utils\/tiktok-posting"/);
      expect(src).not.toMatch(/from "@postautomation\/social"/);
    }
  });
});

describe("one predicate gates submit, both buttons and the banner", () => {
  it("tiktokBlock is derived once and read by the handler, both buttons and the visible notice", () => {
    expect(compose).toMatch(/const tiktokBlock =\s*selectedTikTokIds\.length > 0\s*\?\s*tiktokBlockReason\(\{/);
    expect(compose).toMatch(/if \(tiktokBlock\) \{\s*toast\(\{ title: "TikTok post not ready"/);
    expect(compose.match(/\|\| !!tiktokBlock/g) ?? []).toHaveLength(2);
    expect(compose.match(/captionBlock \?\? tiktokBlock \?\? undefined/g) ?? []).toHaveLength(2);
    expect(compose).toMatch(/\|\| tiktokBlock\) && \(/);
    expect(compose).toMatch(/\{youtubeBlockReason \?\? storyBlock \?\? articleBlock \?\? captionBlock \?\? tiktokBlock\}/);
  });
  it("the duration comes from the SAME probe element as the aspect ratio (no second media element)", () => {
    expect(compose.match(/document\.createElement\("video"\)/g) ?? []).toHaveLength(1);
    expect(compose).toMatch(
      /setVideoAspect\(el\.videoWidth \/ el\.videoHeight\);\s*\}\s*if \(Number\.isFinite\(el\.duration\) && el\.duration > 0\) \{\s*setVideoDurationSec\(el\.duration\);/
    );
    expect(compose).toMatch(/durationSec: videoDurationSec,/);
  });
});

describe("consent and processing notice", () => {
  it("the consent line renders above the action buttons whenever a TikTok channel is selected", () => {
    expect(compose).toMatch(/const tiktokConsent = tiktokConsentLine\(tiktokDrafts, selectedTikTokIds\);/);
    const sep = compose.indexOf("<Separator />\n          {tiktokConsent && (");
    expect(sep).toBeGreaterThan(-1);
    expect(compose).toMatch(/data-testid="tiktok-consent"[^>]*>\s*\{tiktokConsent\}/);
    const publish = compose.indexOf('{isUploading ? "Uploading..."');
    expect(publish).toBeGreaterThan(sep);
  });
  it("the success toast adds TikTok's processing notice, read from the server's targets", () => {
    expect(compose).toMatch(/t\?\.channel\?\.platform === "TIKTOK"/);
    expect(compose).toMatch(/\$\{created\.description\} \$\{TIKTOK_PROCESSING_NOTICE\}/);
    expect(lib).toMatch(/TIKTOK_PROCESSING_NOTICE = "TikTok may take a few minutes to process your video\."/);
  });
});

describe("drafts", () => {
  it("persist on a JSON STRING signature — no hook is keyed on the drafts object", () => {
    expect(compose).toMatch(/const tiktokDraftsSignature = JSON\.stringify\(tiktokDraftsToPersist\);/);
    const depArrays = [...compose.matchAll(/\}, \[([^\]]*)\]\)/g)].map((m) => m[1]!);
    expect(depArrays.length).toBeGreaterThan(5);
    for (const deps of depArrays) {
      expect(deps).not.toMatch(/\btiktokDrafts\b|\btiktokCreators\b|\btiktokDraftsToPersist\b/);
    }
    expect(depArrays.some((d) => /\btiktokDraftsSignature\b/.test(d))).toBe(true);
  });
  it("a restored draft is re-validated field by field, and the choices reset after a create", () => {
    expect(compose).toMatch(/const restoredTikTok = sanitizeRestoredTikTok\(saved\.draft\.tiktok\);/);
    expect(compose).toMatch(/setTiktokDrafts\(\{\}\);\s*removeTask\(TASK_ID\);/);
  });
});

describe("post page", () => {
  it("a PUBLISHING TikTok target says it is processing on TikTok, with the notice", () => {
    expect(postPage).toMatch(/const isTikTok = target\.channel\.platform === "TIKTOK";/);
    expect(postPage).toMatch(/\{isTikTok \? tiktokPublishingLabel\(pct\) : "Uploading…"\}/);
    expect(postPage).toMatch(/\{isTikTok \? tiktokPublishingLabel\(null\) : "Publishing…"\}/);
    expect(postPage).toMatch(/\{TIKTOK_PROCESSING_NOTICE\}/);
  });
  it("the View links render only when the target has a publishedUrl", () => {
    expect(postPage).toMatch(/\{target\.publishedUrl && \(\s*<a\s+href=\{target\.publishedUrl\}/);
    expect(postPage).toMatch(/\.filter\(\(t: any\) => t\.publishedUrl\)/);
  });
  it("the View-on button names TikTok correctly", () => {
    expect(postPage).toMatch(/View on \{platformLinkName\(target\.channel\.platform\)\}/);
    expect(postPage).toMatch(/TIKTOK: "TikTok"/);
  });
});

describe("preview", () => {
  it("the preview tab is labelled 'TikTok', not 'Tiktok'", () => {
    const switcher = read("apps/web/components/previews/post-preview-switcher.tsx");
    expect(switcher).toMatch(/tiktok: "TikTok",/);
  });
});
