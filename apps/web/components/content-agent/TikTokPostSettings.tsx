"use client";

import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { humanizeError } from "~/lib/errors";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Switch } from "~/components/ui/switch";
import { Label } from "~/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { ChannelAvatar } from "~/components/channel-avatar";
import {
  TIKTOK_PRIVACY_LABELS,
  isTikTokPrivacyLevel,
} from "@postautomation/social/src/utils/tiktok-posting";
import {
  type TikTokDraft,
  type TikTokCreatorState,
  type TikTokCreatorInfoResult,
  emptyTikTokDraft,
  creatorStateFromQuery,
  creatorInfoErrorMessage,
  isTooManyRequestsError,
  tiktokCommercialLabel,
  tiktokLengthNote,
  TIKTOK_PRIVACY_PLACEHOLDER,
  TIKTOK_COMMERCIAL_HINT,
  TIKTOK_BRANDED_PRIVATE_TEXT,
  TIKTOK_INTERACTION_OFF_TEXT,
  TIKTOK_CREATOR_RATE_LIMIT_TEXT,
} from "~/lib/tiktok-post";
import type { VideoLengthStatus } from "~/lib/video-length-probe";

/** creator_info is limited to 20 requests/min per token — a minute of cache is plenty. */
const CREATOR_INFO_STALE_MS = 60_000;
/** One automatic retry after the app's rate limit, about when its window resets. */
const CREATOR_INFO_RATE_LIMIT_RETRY_MS = 60_000;

/**
 * Live creator_info for every selected TikTok channel — one query per channel
 * (`tiktok.creatorInfo`), so Compose's submit gate and the card read the SAME
 * state. TikTok requires fresh creator info before every post; the provider
 * fetches it again right before init, so a setting changed after scheduling is
 * still caught.
 *
 * Compose is force-mounted and window-focus refetch is off, so without an
 * interval the settings could be hours old when the user finally schedules —
 * they are re-read every minute while mounted (never from a background tab).
 * A rate-limited read (TOO_MANY_REQUESTS) is retried once, a minute later, and
 * shows fixed text meanwhile instead of the raw "Try again after <ISO>".
 */
export function useTikTokCreators(channelIds: string[]): {
  creators: Record<string, TikTokCreatorState>;
  retry: (channelId: string) => void;
} {
  const results = trpc.useQueries((t) =>
    channelIds.map((channelId) =>
      t.tiktok.creatorInfo(
        { channelId },
        {
          staleTime: CREATOR_INFO_STALE_MS,
          refetchInterval: CREATOR_INFO_STALE_MS,
          refetchIntervalInBackground: false,
          retry: (failureCount, error) => failureCount < 1 && isTooManyRequestsError(error),
          retryDelay: CREATOR_INFO_RATE_LIMIT_RETRY_MS,
        }
      )
    )
  );
  const creators: Record<string, TikTokCreatorState> = {};
  const refetchers: Record<string, () => void> = {};
  channelIds.forEach((id, i) => {
    const q = results[i];
    if (!q) return;
    creators[id] = creatorStateFromQuery({
      isPending: q.isPending,
      errorMessage: creatorInfoErrorMessage(
        { error: q.error, failureReason: q.failureReason, hasData: q.data != null },
        (err) => humanizeError(err, "Couldn't load this account's TikTok settings. Try again.")
      ),
      data: (q.data ?? null) as TikTokCreatorInfoResult | null,
    });
    refetchers[id] = () => void q.refetch();
  });
  return { creators, retry: (id) => refetchers[id]?.() };
}

export interface TikTokChannelSummary {
  id: string;
  name: string;
  avatar?: string | null;
}

/**
 * Compose's TikTok card — one section per selected TikTok channel, because
 * each creator allows different options. Follows TikTok's Content Sharing
 * Guidelines: the creator's nickname is shown, privacy has NO default and lists
 * exactly the creator's options, Comment/Duet/Stitch start unchecked and grey
 * out (with a visible reason — touch devices show no tooltips) when the creator
 * turned them off, commercial disclosure is off by default, and branded
 * content cannot be private.
 */
export function TikTokPostSettings({
  channels,
  creators,
  drafts,
  onChange,
  onRetry,
  videoDurationSec,
  videoLengthStatus,
}: {
  channels: TikTokChannelSummary[];
  creators: Record<string, TikTokCreatorState>;
  drafts: Record<string, TikTokDraft>;
  onChange: (channelId: string, next: TikTokDraft) => void;
  onRetry?: (channelId: string) => void;
  /** The first video's length, only once it was measured from THAT video. */
  videoDurationSec: number | null;
  videoLengthStatus: VideoLengthStatus;
}) {
  if (channels.length === 0) return null;
  return (
    <Card data-testid="tiktok-post-settings">
      <CardHeader className="pb-3">
        <CardTitle>TikTok</CardTitle>
        <CardDescription>
          Choose these for every TikTok post. Each account&apos;s options come from TikTok and can differ.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {channels.map((ch) => (
          <TikTokChannelSection
            key={ch.id}
            channel={ch}
            creator={creators[ch.id] ?? { status: "loading" }}
            draft={drafts[ch.id] ?? emptyTikTokDraft()}
            onChange={(next) => onChange(ch.id, next)}
            onRetry={onRetry ? () => onRetry(ch.id) : undefined}
            videoDurationSec={videoDurationSec}
            videoLengthStatus={videoLengthStatus}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function TikTokChannelSection({
  channel,
  creator,
  draft,
  onChange,
  onRetry,
  videoDurationSec,
  videoLengthStatus,
}: {
  channel: TikTokChannelSummary;
  creator: TikTokCreatorState;
  draft: TikTokDraft;
  onChange: (next: TikTokDraft) => void;
  onRetry?: () => void;
  videoDurationSec: number | null;
  videoLengthStatus: VideoLengthStatus;
}) {
  const info = creator.status === "ready" ? creator.info : null;
  const displayName = info?.nickname || channel.name;
  const set = (patch: Partial<TikTokDraft>) => onChange({ ...draft, ...patch });
  const idBase = `tiktok-${channel.id}`;

  return (
    <div className="space-y-3 rounded-md border p-3" data-testid="tiktok-channel-settings">
      <div className="flex min-w-0 items-center gap-2.5">
        <ChannelAvatar
          avatar={info?.avatarUrl ?? channel.avatar ?? null}
          name={displayName}
          className="h-8 w-8"
          fallbackClassName="text-[11px]"
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{displayName}</p>
          {info?.username ? <p className="truncate text-xs text-muted-foreground">@{info.username}</p> : null}
        </div>
      </div>

      {creator.status === "loading" ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading this account&apos;s TikTok settings…
        </div>
      ) : creator.status === "error" || creator.status === "cannot-post" ? (
        <div
          className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300"
          data-testid="tiktok-channel-blocked"
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-none" />
          <div className="min-w-0 flex-1">
            <p>
              {creator.status === "error"
                ? creator.message || "Couldn't load this account's TikTok settings."
                : creator.reason || "This TikTok account can't post right now. Try again later."}
            </p>
            {/* No button while rate-limited: it re-checks on its own, and a
                click would only spend more of the same limit. */}
            {onRetry && !(creator.status === "error" && creator.message === TIKTOK_CREATOR_RATE_LIMIT_TEXT) ? (
              <Button type="button" variant="ghost" size="sm" className="mt-1 h-7 px-2 text-xs" onClick={onRetry}>
                <RefreshCw className="mr-1 h-3 w-3" /> Check again
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <ReadySection
          idBase={idBase}
          info={creator.info}
          draft={draft}
          set={set}
          videoDurationSec={videoDurationSec}
          videoLengthStatus={videoLengthStatus}
        />
      )}
    </div>
  );
}

function ReadySection({
  idBase,
  info,
  draft,
  set,
  videoDurationSec,
  videoLengthStatus,
}: {
  idBase: string;
  info: Extract<TikTokCreatorState, { status: "ready" }>["info"];
  draft: TikTokDraft;
  set: (patch: Partial<TikTokDraft>) => void;
  videoDurationSec: number | null;
  videoLengthStatus: VideoLengthStatus;
}) {
  const brandedOn = draft.discloseCommercial && draft.brandContent;
  // A restored privacy level the creator no longer allows shows the
  // placeholder (the gate explains why) instead of a blank trigger.
  const privacyValue =
    draft.privacyLevel && info.privacyLevelOptions.includes(draft.privacyLevel) ? draft.privacyLevel : "";
  const commercialLabel = tiktokCommercialLabel(draft);
  // A length that couldn't be read here is said quietly and never blocks — the
  // server and the publish worker check it again.
  const lengthNote = tiktokLengthNote({
    maxSec: info.maxVideoPostDurationSec,
    durationSec: videoDurationSec,
    lengthStatus: videoLengthStatus,
  });

  const interactions: Array<{ key: "allowComment" | "allowDuet" | "allowStitch"; label: string; off: boolean }> = [
    { key: "allowComment", label: "Comment", off: info.commentDisabled },
    { key: "allowDuet", label: "Duet", off: info.duetDisabled },
    { key: "allowStitch", label: "Stitch", off: info.stitchDisabled },
  ];

  return (
    <div className="space-y-4">
      {/* Privacy — exactly the creator's options, NO default. */}
      <div className="space-y-1.5">
        <Label htmlFor={`${idBase}-privacy`} className="text-xs font-medium">
          Who can see this video
        </Label>
        <Select
          value={privacyValue}
          onValueChange={(v) => {
            if (isTikTokPrivacyLevel(v)) set({ privacyLevel: v });
          }}
        >
          <SelectTrigger id={`${idBase}-privacy`} data-testid="tiktok-privacy">
            <SelectValue placeholder={TIKTOK_PRIVACY_PLACEHOLDER} />
          </SelectTrigger>
          <SelectContent>
            {info.privacyLevelOptions.map((level) => {
              const blocked = level === "SELF_ONLY" && brandedOn;
              return (
                <SelectItem key={level} value={level} disabled={blocked}>
                  {TIKTOK_PRIVACY_LABELS[level]}
                  {blocked ? ` — ${TIKTOK_BRANDED_PRIVATE_TEXT}` : ""}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        {brandedOn && info.privacyLevelOptions.includes("SELF_ONLY") ? (
          <p className="text-[11px] text-muted-foreground">{TIKTOK_BRANDED_PRIVATE_TEXT}</p>
        ) : null}
      </div>

      {/* Interactions — unchecked until the user opts in. */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium">Allow users to</p>
        <div className="space-y-1.5">
          {interactions.map(({ key, label, off }) => {
            const checked = draft[key];
            // A setting the creator turned off cannot be switched on — but a
            // restored "on" can still be switched off, or the post is stuck.
            const disabled = off && !checked;
            return (
              <div key={key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <Checkbox
                  id={`${idBase}-${key}`}
                  checked={checked}
                  disabled={disabled}
                  onCheckedChange={(v) => set({ [key]: v } as Partial<TikTokDraft>)}
                />
                <Label htmlFor={`${idBase}-${key}`} className={`text-sm ${disabled ? "text-muted-foreground" : ""}`}>
                  {label}
                </Label>
                {off ? <span className="text-[11px] text-muted-foreground">{TIKTOK_INTERACTION_OFF_TEXT}</span> : null}
              </div>
            );
          })}
        </div>
      </div>

      {/* Commercial content disclosure — off by default. */}
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Label htmlFor={`${idBase}-disclose`} className="text-sm font-medium">
              Disclose commercial content
            </Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Turn on to disclose that this video promotes goods or services in exchange for something of value. It
              could promote yourself, a third party, or both.
            </p>
          </div>
          <Switch
            id={`${idBase}-disclose`}
            checked={draft.discloseCommercial}
            onCheckedChange={(v) => set({ discloseCommercial: v })}
          />
        </div>
        {draft.discloseCommercial ? (
          <div className="space-y-2 rounded-md bg-muted/40 p-2.5">
            <div className="flex items-start gap-2">
              <Checkbox
                id={`${idBase}-brand-organic`}
                className="mt-0.5"
                checked={draft.brandOrganic}
                onCheckedChange={(v) => set({ brandOrganic: v })}
              />
              <div className="min-w-0">
                <Label htmlFor={`${idBase}-brand-organic`} className="text-sm">
                  Your brand
                </Label>
                <p className="text-xs text-muted-foreground">
                  You are promoting yourself or your own business.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id={`${idBase}-brand-content`}
                className="mt-0.5"
                checked={draft.brandContent}
                // Branded content cannot be private: blocked while "Only me" is
                // chosen — unless it is already on, so it can be switched off.
                disabled={draft.privacyLevel === "SELF_ONLY" && !draft.brandContent}
                onCheckedChange={(v) => set({ brandContent: v })}
              />
              <div className="min-w-0">
                <Label htmlFor={`${idBase}-brand-content`} className="text-sm">
                  Branded content
                </Label>
                <p className="text-xs text-muted-foreground">
                  You are promoting another brand or a third party.
                </p>
                {draft.privacyLevel === "SELF_ONLY" ? (
                  <p className="text-[11px] text-amber-700 dark:text-amber-400">{TIKTOK_BRANDED_PRIVATE_TEXT}</p>
                ) : null}
              </div>
            </div>
            {!draft.brandOrganic && !draft.brandContent ? (
              <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="tiktok-commercial-hint">
                {TIKTOK_COMMERCIAL_HINT}
              </p>
            ) : null}
            {commercialLabel ? <p className="text-xs font-medium">{commercialLabel}</p> : null}
          </div>
        ) : null}
      </div>

      {/* AI-generated content label — optional. */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor={`${idBase}-aigc`} className="text-sm font-medium">
            AI-generated content
          </Label>
          <p className="mt-0.5 text-xs text-muted-foreground">Label this video as AI-generated on TikTok.</p>
        </div>
        <Switch id={`${idBase}-aigc`} checked={draft.isAigc} onCheckedChange={(v) => set({ isAigc: v })} />
      </div>

      {lengthNote ? (
        <p
          className={`text-xs ${lengthNote.tooLong ? "text-destructive" : "text-muted-foreground"}`}
          data-testid="tiktok-length-note"
        >
          {lengthNote.text}
        </p>
      ) : null}
    </div>
  );
}
