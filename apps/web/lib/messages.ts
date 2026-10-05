/**
 * Messages inbox (2026-10-05) — small pure helpers for the UI.
 *
 * Meta lets a Page / Instagram account reply only inside the 24-hour
 * "standard messaging window" that opens when the person writes. The server
 * works out whether it is open from the loaded messages; this turns that into
 * the line shown above the composer.
 */

export interface WindowInfo {
  windowOpen: boolean | null;
  windowClosesAt: string | null;
}

export function messagingWindowLabel(w: WindowInfo, now: number = Date.now()): { tone: "open" | "closed" | "unknown"; text: string } {
  if (w.windowOpen === true && w.windowClosesAt) {
    const ms = Date.parse(w.windowClosesAt) - now;
    if (Number.isFinite(ms) && ms > 0) {
      const hours = Math.floor(ms / 3_600_000);
      const minutes = Math.max(1, Math.floor((ms % 3_600_000) / 60_000));
      return { tone: "open", text: hours >= 1 ? `You can reply for ${hours}h ${minutes}m more.` : `You can reply for ${minutes} more minute${minutes === 1 ? "" : "s"}.` };
    }
    return { tone: "closed", text: "The 24-hour reply window has just closed. You can reply again after they write." };
  }
  if (w.windowOpen === false) {
    return { tone: "closed", text: "Meta only allows a reply within 24 hours of their last message. You can reply again after they write." };
  }
  return { tone: "unknown", text: "Replies are allowed within 24 hours of their last message — Meta will refuse it if that has passed." };
}

/** "Asha" / "@fan" / "Someone" — the person in a conversation. */
export function participantLabel(p: { name: string | null; username: string | null } | null | undefined): string {
  if (p?.name) return p.name;
  if (p?.username) return `@${p.username}`;
  return "Someone";
}

/** Server messages for an outcome we couldn't confirm (it may have been sent). */
export function isUnconfirmedSend(message: unknown): boolean {
  return /didn't confirm (the private reply|that message)|may already have been sent/i.test(String(message ?? ""));
}

/** Instagram counts UTF-8 bytes (1,000); Messenger counts characters (2,000). */
export function messageLength(platform: "FACEBOOK" | "INSTAGRAM", text: string): { used: number; max: number; unit: string } {
  if (platform === "INSTAGRAM") return { used: new TextEncoder().encode(text).length, max: 1000, unit: "bytes" };
  return { used: text.length, max: 2000, unit: "" };
}
