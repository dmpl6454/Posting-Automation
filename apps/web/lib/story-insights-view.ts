/**
 * Display helpers for the Insights → Stories tab (2026-11-05). Pure, so the
 * wording and the CSV layout are unit-tested.
 */

export type StoryStatus = "measured" | "pending" | "low_viewers" | "reconnect" | "not_available";

export interface StoryRowView {
  platform: string;
  channelName: string;
  channelHandle: string | null;
  publishedAt: string | Date;
  expiresAt: string | Date;
  live: boolean;
  final: boolean;
  status: StoryStatus;
  url: string | null;
  note: string;
  capturedAt: string | Date | null;
  views: number | null;
  reach: number | null;
  shares: number | null;
  replies: number | null;
  totalInteractions: number | null;
  tapsForward: number | null;
  tapsBack: number | null;
  exits: number | null;
  swipeForward: number | null;
  profileVisits: number | null;
  follows: number | null;
  linkClicks: number | null;
}

/** The metric columns, in display order. Used by both the table and the CSV. */
export const STORY_METRIC_COLUMNS: { key: keyof StoryRowView; label: string; hint: string }[] = [
  { key: "views", label: "Views", hint: "Times the story was viewed" },
  { key: "reach", label: "Reach", hint: "Accounts that saw the story at least once (Meta's estimate)" },
  { key: "replies", label: "Replies", hint: "Replies to the story. Meta reports 0 for stories made in Europe or Japan" },
  { key: "shares", label: "Shares", hint: "Times the story was shared" },
  { key: "tapsForward", label: "Taps fwd", hint: "Taps to see the next photo or video" },
  { key: "tapsBack", label: "Taps back", hint: "Taps to see the previous photo or video" },
  { key: "exits", label: "Exits", hint: "Times someone left the story" },
  { key: "swipeForward", label: "Next story", hint: "Swipes to the next account's story" },
  { key: "profileVisits", label: "Profile visits", hint: "Profile visits from the story" },
  { key: "follows", label: "Follows", hint: "Accounts that followed after seeing the story" },
  { key: "linkClicks", label: "Link clicks", hint: "Taps on a link sticker" },
];

export function storyStatusLabel(status: StoryStatus): string {
  switch (status) {
    case "measured":
      return "";
    case "pending":
      return "Waiting for the first sync";
    case "low_viewers":
      return "Under 5 viewers, so Instagram shows no insights";
    case "reconnect":
      return "Insights failed. Reconnect this channel";
    case "not_available":
      return "Facebook doesn't report story insights";
  }
}

/** "Live, 6h left" / "Live, 40m left" / "Ended". */
export function storyLifeLabel(row: Pick<StoryRowView, "live" | "expiresAt">, now: Date = new Date()): string {
  if (!row.live) return "Ended";
  const ms = new Date(row.expiresAt).getTime() - now.getTime();
  if (ms <= 0) return "Ended";
  const mins = Math.floor(ms / 60_000);
  return mins >= 60 ? `Live, ${Math.floor(mins / 60)}h left` : `Live, ${Math.max(mins, 1)}m left`;
}

/** Whether the numbers shown are the end-of-life reading or still moving. */
export function storyReadingLabel(row: Pick<StoryRowView, "status" | "final" | "live">): string {
  if (row.status !== "measured") return "";
  if (row.final) return "Final";
  return row.live ? "So far" : "Last reading";
}

export function metricText(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : v.toLocaleString("en-IN");
}

function iso(v: string | Date | null): string {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 16).replace("T", " ");
}

/** CSV header + rows. Unreported metrics are left blank, never 0. */
export function storyCsv(rows: StoryRowView[]): { header: string[]; body: (string | number | null)[][] } {
  const header = [
    "Platform",
    "Channel",
    "Handle",
    "Published (UTC)",
    "Status",
    "Reading",
    "Captured (UTC)",
    ...STORY_METRIC_COLUMNS.map((c) => c.label),
    "Link",
    "Note",
  ];
  const body = rows.map((r) => [
    r.platform,
    r.channelName,
    r.channelHandle ?? "",
    iso(r.publishedAt),
    r.status === "measured" ? (r.live ? "Live" : "Ended") : storyStatusLabel(r.status),
    storyReadingLabel(r),
    iso(r.capturedAt),
    ...STORY_METRIC_COLUMNS.map((c) => {
      const v = r[c.key];
      return typeof v === "number" ? v : null;
    }),
    r.url ?? "",
    r.note,
  ]);
  return { header, body };
}
