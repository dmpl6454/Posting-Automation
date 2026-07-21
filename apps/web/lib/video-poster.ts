/**
 * Append a `#t=0.001` media fragment so Safari paints a poster frame.
 *
 * Safari/WebKit never renders a frame for `preload="metadata"` videos —
 * every video tile in the Media library / pickers showed as a BLACK box on
 * Safari while Chrome showed the first frame ("videos never preview",
 * 2026-07-21). The fragment makes WebKit seek + decode frame 1: verified
 * with Playwright WebKit 26.0 — readyState 2 (frame available) in ~0.4s for
 * a normal mp4, ~3.5s even for a 1.6GB 4K master. Chromium ignores the
 * fragment harmlessly. No-op when the URL already carries a fragment.
 */
export function withPosterHint(url: string): string {
  return url.includes("#") ? url : `${url}#t=0.001`;
}
