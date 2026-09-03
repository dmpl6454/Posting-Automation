"use client";

import { useState } from "react";

/**
 * Platform Performance — the mockup's five-axis radar.
 *
 * Geometry is copied verbatim from the design (viewBox 280x256, centre
 * 140/128, radius 80, rings at 20/40/60/80/100, first axis at -90 deg and each
 * subsequent one a fifth of a turn clockwise), so the plot lands pixel-for-pixel
 * where the mockup puts it.
 *
 * ⚠️ ONE DELIBERATE SUBSTITUTION. The mockup's fifth axis is "Audience Growth",
 * which is follower growth over the window. This app stores no follower history
 * — `perChannelStats` has no such field and nothing collects it — so that axis
 * has no data source. Rather than plot a fabricated number (a constant 0 would
 * normalise to 50 for every channel and look like a real reading), the fifth
 * axis is CLICKS, which the app genuinely measures. Same pentagon, same colours,
 * every axis backed by a real figure.
 *
 * The other honesty rule: a channel whose platform never reports a metric
 * (Instagram has no click metric, for instance) is EXCLUDED from that axis's
 * normalisation and plotted at the centre with a "not reported" tooltip — it
 * must not be ranked against channels that did report.
 */

export interface RadarChannel {
  id: string;
  name: string;
  platform: string;
  color: string;
  /** Metric list from perChannelStats; unavailable keys render as "not reported". */
  unavailable?: string[];
  postCount: number;
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
  engagementRate?: number | null;
}

const METRIC_LONG = [
  "Engagement Rate",
  "Reach Performance",
  "Interaction Rate",
  "Content Activity",
  "Click Performance",
] as const;
const METRIC_SHORT = ["Engagement", "Reach", "Interaction", "Content", "Clicks"] as const;
/** Design's per-axis label border colours, in axis order. */
const AXIS_COLORS = ["#8A7239", "#6C93D1", "#C9695F", "#6FAE7D", "#A183C9"] as const;
const WIDE_LABELS = new Set(["Engagement", "Interaction"]);

const CX = 140;
const CY = 128;
const R = 80;

const angleAt = (i: number) => -Math.PI / 2 + i * ((2 * Math.PI) / 5);
function pointAt(i: number, pct: number): [number, number] {
  const a = angleAt(i);
  const r = R * (pct / 100);
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}
const toPoints = (pts: [number, number][]) => pts.map(([x, y]) => `${x},${y}`).join(" ");

/**
 * Min-max normalisation to 0–100 over the values that EXIST. `null` stays null
 * (not reported). A single reporting channel, or an all-equal set, sits at 50 —
 * ranking one value against itself is meaningless, so the midpoint is the only
 * non-misleading answer.
 */
function normalise(values: (number | null)[]): (number | null)[] {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return values.map(() => null);
  const min = Math.min(...present);
  const max = Math.max(...present);
  return values.map((v) =>
    v === null ? null : max === min ? 50 : Math.round(((v - min) / (max - min)) * 100)
  );
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

interface HoverState {
  x: number;
  y: number;
  name: string;
  platformLabel: string;
  metric: string;
  value: string;
}

export function PlatformPerformanceRadar({
  channels,
  platformLabel,
}: {
  channels: RadarChannel[];
  platformLabel: (platform: string) => string;
}) {
  const [selected, setSelected] = useState<string[] | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  if (channels.length === 0) return null;

  const has = (ch: RadarChannel, key: string) => !(ch.unavailable ?? []).includes(key);

  // Raw per-channel figures. null = this platform does not report the metric.
  const raw = channels.map((ch) => {
    const interactionBase = ch.likes + ch.comments + ch.shares;
    return {
      engagement: has(ch, "impressions") || has(ch, "views") ? ch.engagementRate ?? null : null,
      reach: has(ch, "impressions") ? ch.impressions : null,
      interaction:
        interactionBase > 0 ? ((ch.comments + ch.shares) / interactionBase) * 100 : null,
      content: ch.postCount,
      clicks: has(ch, "clicks") ? ch.clicks : null,
    };
  });

  const scoreCols = [
    normalise(raw.map((r) => r.engagement)),
    normalise(raw.map((r) => r.reach)),
    normalise(raw.map((r) => r.interaction)),
    normalise(raw.map((r) => r.content)),
    normalise(raw.map((r) => r.clicks)),
  ];

  const rows = channels.map((ch, i) => {
    const scores = scoreCols.map((col) => col[i] ?? null);
    const display = [
      raw[i]!.engagement === null ? "not reported" : `${raw[i]!.engagement!.toFixed(1)}%`,
      raw[i]!.reach === null ? "not reported" : fmtK(raw[i]!.reach!),
      raw[i]!.interaction === null ? "not reported" : `${raw[i]!.interaction!.toFixed(1)}%`,
      `${raw[i]!.content} posts`,
      raw[i]!.clicks === null ? "not reported" : fmtK(raw[i]!.clicks!),
    ];
    return { ch, scores, display, total: scores.reduce<number>((a, v) => a + (v ?? 0), 0) };
  });

  // Design default: the four strongest channels, so the chart opens readable
  // rather than as an unreadable seven-polygon tangle.
  const defaultSelected = [...rows]
    .sort((a, b) => b.total - a.total)
    .slice(0, 4)
    .map((r) => r.ch.id);
  const activeIds = new Set(selected ?? defaultSelected);

  const toggle = (id: string) => {
    const next = new Set(selected ?? defaultSelected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(Array.from(next));
  };

  const rings = [20, 40, 60, 80, 100].map((ring) =>
    toPoints([0, 1, 2, 3, 4].map((i) => pointAt(i, ring)))
  );

  const axes = [0, 1, 2, 3, 4].map((i) => {
    const [x2, y2] = pointAt(i, 100);
    // Push the label further out on the horizontal axes so it clears the plot.
    const outward = Math.abs(Math.cos(angleAt(i))) > 0.3 ? 145 : 125;
    const [lx, ly] = pointAt(i, outward);
    const label = METRIC_SHORT[i]!;
    const w = Math.max(34, label.length * 4.4 + (WIDE_LABELS.has(label) ? 18 : 10));
    const h = 16;
    return { x2, y2, label, color: AXIS_COLORS[i]!, x: lx - w / 2, y: ly - h / 2, w, h };
  });

  const drawn = rows.filter((r) => activeIds.has(r.ch.id));

  /* Plot capped at 520px on the left, channel list pinned to the card's RIGHT
     edge — `justify-between` puts the slack between the two columns rather than
     after them, so the list sits where the mockup puts it. */
  return (
    /* `items-start`, NOT `items-center`. The legend column grows with the
       channel count, and centring aligned the plot to the MIDDLE of that
       column — measured: a 40-channel workspace pushed the chart 770px down
       and a 110-channel one 2,527px, so the card opened on a wall of buttons
       with the chart far below the fold. The plot must stay pinned to the top
       however tall the list gets. */
    <div className="mt-4 grid items-start gap-y-3.5 lg:grid-cols-[minmax(0,520px)_200px] lg:justify-between lg:gap-x-8">
      {/* The plot is capped and LEFT-aligned rather than filling the whole 1fr
          column. At full width it renders ~660px across — matching the mockup's
          measured 676px, but on a workspace with little data that is a lot of
          empty pentagon, so it is held to 520px. Left-aligned because centring
          the capped plot left a wide gutter against the card's left edge while
          crowding the legend. Geometry is untouched: the viewBox scales, so
          every ring, axis and label keeps its proportions. */}
      <div className="flex justify-start px-2">
        <div className="relative w-full max-w-[520px]">
          <svg viewBox="0 0 280 256" className="h-auto w-full overflow-visible">
            {rings.map((points, i) => (
              <polygon key={`ring-${i}`} points={points} fill="none" stroke="hsl(var(--border))" strokeWidth={1} />
            ))}
            {axes.map((ax, i) => (
              <line key={`axis-${i}`} x1={CX} y1={CY} x2={ax.x2} y2={ax.y2} stroke="hsl(var(--border))" strokeWidth={1} />
            ))}
            {drawn.map((r) => (
              <polygon
                key={`poly-${r.ch.id}`}
                points={toPoints(r.scores.map((v, i) => pointAt(i, v ?? 0)))}
                fill={r.ch.color}
                fillOpacity={0.1}
                stroke={r.ch.color}
                strokeWidth={2}
                strokeLinejoin="round"
              />
            ))}
            {drawn.map((r) =>
              r.scores.map((v, i) => {
                const [x, y] = pointAt(i, v ?? 0);
                return (
                  <circle
                    key={`dot-${r.ch.id}-${i}`}
                    cx={x}
                    cy={y}
                    r={3.5}
                    fill={r.ch.color}
                    stroke="hsl(var(--card))"
                    strokeWidth={1.5}
                    className="cursor-pointer"
                    onMouseEnter={() =>
                      setHover({
                        x,
                        y,
                        name: r.ch.name,
                        platformLabel: platformLabel(r.ch.platform),
                        metric: METRIC_LONG[i]!,
                        value: r.display[i]!,
                      })
                    }
                    onMouseLeave={() => setHover(null)}
                  />
                );
              })
            )}
            {axes.map((ax, i) => (
              <foreignObject key={`label-${i}`} x={ax.x} y={ax.y} width={ax.w} height={ax.h} style={{ overflow: "visible" }} className="pointer-events-none">
                <div
                  className="flex h-full w-full items-center justify-center whitespace-nowrap rounded-[5px] bg-surface1 text-center text-[6.5px] font-semibold uppercase leading-none tracking-[0.03em] text-muted-foreground"
                  style={{ boxSizing: "border-box", border: `1px solid ${ax.color}`, boxShadow: "0 2px 6px rgba(0,0,0,.35)" }}
                >
                  {ax.label}
                </div>
              </foreignObject>
            ))}
          </svg>
          {hover && (
            <div
              className="pointer-events-none absolute z-[5] whitespace-nowrap rounded-[8px] border border-border2 bg-card px-[11px] py-2 shadow-[0_10px_22px_-10px_rgba(0,0,0,.6)]"
              style={{ left: `${(hover.x / 280) * 100}%`, top: `${(hover.y / 256) * 100}%`, transform: "translate(-50%,-115%)" }}
            >
              <div className="text-[12px] font-semibold leading-[1.3]">{hover.name}</div>
              <div className="text-[10.5px] leading-[1.4] text-muted-foreground">{hover.platformLabel}</div>
              <div className="mt-1 text-[11.5px] font-medium leading-[1.3] text-gold">
                {hover.metric}: {hover.value}
              </div>
            </div>
          )}
        </div>
      </div>
      {/* Capped and scrollable. Unbounded, this column set the whole card's
          height — 5,514px on a 110-channel workspace. The cap is the plot's
          own rendered height, so the two columns end together and the card
          stays one screenful whatever the channel count. */}
      <div className="flex max-h-[460px] flex-col gap-2 overflow-y-auto pr-1">
        {rows.map((r) => {
          const on = activeIds.has(r.ch.id);
          return (
            <button
              key={r.ch.id}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(r.ch.id)}
              className={`flex items-center gap-[7px] rounded-[8px] border px-2.5 py-1.5 text-left transition-opacity ${
                on ? "bg-tile opacity-100" : "border-border bg-transparent opacity-55"
              }`}
              style={on ? { borderColor: r.ch.color } : undefined}
            >
              <span className="h-[9px] w-[9px] shrink-0 rounded-full" style={{ backgroundColor: r.ch.color }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium leading-[1.3]">{r.ch.name}</span>
                <span className="block text-[10px] leading-[1.3] text-muted-foreground">
                  {platformLabel(r.ch.platform)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
