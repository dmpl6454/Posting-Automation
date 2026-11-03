import { getSocialProvider } from "@postautomation/social";
import type { CommentPoster } from "./first-comment";

/**
 * The provider call behind the automatic first comments: Instagram comments
 * as the account on its media, Facebook comments as the Page on its post.
 * Kept out of first-comment.ts so that file's tests need no provider graph.
 */
export const postCommentViaProvider: CommentPoster = (platform, tokens, objectId, message, pageId) => {
  if (platform === "INSTAGRAM") {
    const ig = getSocialProvider("INSTAGRAM" as any) as unknown as {
      commentOnMedia: (t: typeof tokens, mediaId: string, m: string) => Promise<{ id: string }>;
    };
    return ig.commentOnMedia(tokens, objectId, message);
  }
  if (platform === "FACEBOOK") {
    const fb = getSocialProvider("FACEBOOK" as any) as unknown as {
      commentOnPost: (t: typeof tokens, id: string, m: string, pageId?: string | null) => Promise<{ id: string }>;
    };
    return fb.commentOnPost(tokens, objectId, message, pageId);
  }
  return Promise.reject(new Error(`First comments are not supported on ${platform}.`));
};

/** The Facebook Page id a channel posts as (its stored pageId, else the channel's platform id). */
export function channelPageId(channel: { platform: string; platformId: string; metadata: unknown }): string | null {
  if (channel.platform !== "FACEBOOK") return null;
  const fromMeta = (channel.metadata as any)?.pageId;
  return typeof fromMeta === "string" && fromMeta ? fromMeta : channel.platformId;
}
