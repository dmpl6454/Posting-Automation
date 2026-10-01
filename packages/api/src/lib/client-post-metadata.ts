/**
 * Keys a client must never set on Post.metadata.
 *
 * Post.metadata is `.passthrough()`, and the publish worker merges it into the
 * metadata every provider receives (channel metadata is spread last, but it
 * only overrides keys the channel row actually has). These keys choose WHERE a
 * post is sent or which credential path is used — a WordPress.com channel with
 * no blog_id would take the client's — so they may only come from the channel
 * row, which the connect-time validators wrote (2026-10-01).
 */
export const CHANNEL_ROUTING_KEYS = ["blog_id", "siteUrl", "instance", "service", "webhookUrl", "kind"] as const;

export function stripChannelRoutingKeys(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...metadata };
  for (const k of CHANNEL_ROUTING_KEYS) delete out[k];
  return out;
}
