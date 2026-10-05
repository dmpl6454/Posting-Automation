import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source-level locks for the unanswered queue and the Instagram comments
 * on/off control (2026-10-05).
 */
const queue = readFileSync(join(__dirname, "../components/comments/unanswered-queue.tsx"), "utf8");
const thread = readFileSync(join(__dirname, "../components/comments/comment-thread.tsx"), "utf8");
const page = readFileSync(join(__dirname, "../app/dashboard/comments/page.tsx"), "utf8");
const store = readFileSync(join(__dirname, "./comment-queue.ts"), "utf8");

describe("unanswered queue", () => {
  it("loads only when the Unanswered view is chosen (it is a set of live Graph reads)", () => {
    expect(page).toMatch(/view === "unanswered" \?/);
    expect(page).toMatch(/viewParam === "unanswered" \|\| viewParam === "automation" \? viewParam : "posts"/);
    expect(queue).toMatch(/retry: false/);
    expect(queue).toMatch(/refetchOnWindowFocus: false/);
  });

  it("only ever hands an image URL to <img>", () => {
    expect(queue).toMatch(/src=\{p\.thumbnailUrl\}/);
    expect(queue).not.toMatch(/<img[^>]*src=\{(?!p\.thumbnailUrl)/);
  });

  it("an unconfirmed reply never reads as a plain failure", () => {
    expect(queue).toMatch(/classifyReplyFailure\(err as any\) === "unconfirmed"/);
    expect(queue).toMatch(/Send again anyway/);
  });

  it("AI only drafts — the reply goes out from the Send button", () => {
    expect(queue).toMatch(/comment\.suggestReply\.useMutation/);
    const suggestBlock = queue.slice(queue.indexOf("const draftWithAi"), queue.indexOf("const posts ="));
    expect(suggestBlock).not.toMatch(/reply\.mutate/);
  });

  it("Done is per-browser storage behind try/catch", () => {
    expect(store).toMatch(/try \{\s*return parseDoneMap\(window\.localStorage\.getItem/);
    expect(store).toMatch(/try \{\s*window\.localStorage\.setItem/);
  });
});

describe("Instagram comments on/off", () => {
  it("is asked about only for Instagram threads", () => {
    expect(thread).toMatch(/commentSettings\.useQuery\([\s\S]*?enabled: knownPlatform === "INSTAGRAM"/);
  });

  it("turning comments OFF goes through a confirm dialog; turning them on does not", () => {
    expect(thread).toMatch(/commentsEnabled \? setConfirmCommentsOff\(true\) : setCommentsEnabled\.mutate\(\{ targetId, enabled: true \}\)/);
    expect(thread).toMatch(/onConfirm=\{\(\) => setCommentsEnabled\.mutate\(\{ targetId, enabled: false \}\)\}/);
  });

  it("is disabled when the account lacks the write permission", () => {
    expect(thread).toMatch(/disabled=\{writeBlocked \|\| setCommentsEnabled\.isPending\}/);
  });
});
