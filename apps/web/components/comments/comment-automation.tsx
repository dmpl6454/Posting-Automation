"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, Bell, EyeOff, Loader2, ShieldCheck, Smile } from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { humanizeError } from "~/lib/errors";
import {
  describeLastRun,
  describeReason,
  formatBlockedWords,
  parseBlockedWordsInput,
  type RunSummary,
} from "~/lib/comment-automation";
import { useToast } from "~/hooks/use-toast";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { Skeleton } from "~/components/ui/skeleton";
import { PlatformGlyph, type CommentPlatform } from "~/components/comments/comment-thread";
import { YouTubeIcon } from "~/components/icons/platform-icons";
import { cn } from "~/lib/utils";

/**
 * Comment automation (2026-10-05): auto-hide rules and new-comment alerts.
 *
 * Runs in the background every 15 minutes on the workspace's recent posts
 * (see apps/worker/src/lib/comment-sweep.ts). This tab only edits the settings
 * and shows what the automation hid, with a one-click Unhide.
 */
export function CommentAutomation() {
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const settingsQuery = trpc.comment.automationSettings.useQuery(undefined, { refetchOnWindowFocus: false });
  const logQuery = trpc.comment.autoHideLog.useQuery({ limit: 50 }, { refetchOnWindowFocus: false });

  const [autoHide, setAutoHide] = useState(false);
  const [wordsText, setWordsText] = useState("");
  const [hideLinks, setHideLinks] = useState(false);
  const [alerts, setAlerts] = useState(false);
  const [sentiment, setSentiment] = useState(false);
  const [allAccounts, setAllAccounts] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [unhidingId, setUnhidingId] = useState<string | null>(null);

  const data = settingsQuery.data;
  useEffect(() => {
    if (!data || loadedOnce) return;
    setAutoHide(data.settings.autoHideEnabled);
    setWordsText(formatBlockedWords(data.settings.blockedWords));
    setHideLinks(data.settings.hideLinks);
    setAlerts(data.settings.alertsEnabled);
    setSentiment(data.settings.sentimentEnabled);
    setAllAccounts(data.settings.channelIds.length === 0);
    setPicked(new Set(data.settings.channelIds));
    setLoadedOnce(true);
  }, [data, loadedOnce]);

  const words = useMemo(() => parseBlockedWordsInput(wordsText), [wordsText]);
  const canEdit = data?.canEdit === true;
  const noRule = autoHide && words.length === 0 && !hideLinks;
  const scopeEmpty = !allAccounts && picked.size === 0;

  const save = trpc.comment.updateAutomation.useMutation({
    onSuccess: (res) => {
      setWordsText(formatBlockedWords(res.blockedWords));
      setPicked(new Set(res.channelIds));
      toast({ title: "Comment automation saved", description: "It runs every 15 minutes on your recent posts." });
      void utils.comment.automationSettings.invalidate();
    },
    onError: (err) => toast({ title: "Couldn't save", description: humanizeError(err), variant: "destructive" }),
  });

  const unhide = trpc.comment.moderate.useMutation({
    onSettled: () => setUnhidingId(null),
    onSuccess: () => {
      toast({ title: "Comment unhidden", description: "The automation won't hide it again." });
      void logQuery.refetch();
    },
    onError: (err) => {
      if (/didn't confirm that change/i.test(err.message)) {
        toast({ title: "Change not confirmed", description: "Check the post's comments to see its current state." });
        return;
      }
      toast({ title: "Couldn't unhide", description: humanizeError(err), variant: "destructive" });
    },
  });

  if (settingsQuery.isLoading) return <Skeleton className="h-72 w-full" />;
  if (settingsQuery.isError || !data) {
    return <p className="text-sm text-destructive">{humanizeError(settingsQuery.error)}</p>;
  }

  const scopedAccounts = allAccounts ? data.accounts : data.accounts.filter((a) => picked.has(a.id));
  const cannotHide = autoHide ? scopedAccounts.filter((a) => a.canModerate === false) : [];
  const summary = data.lastRunSummary as RunSummary | null;

  return (
    <div className="space-y-5" data-testid="comment-automation">
      {!canEdit && (
        <p className="rounded-md border bg-muted/40 p-2.5 text-xs text-muted-foreground">
          Only workspace owners and admins can change these settings.
        </p>
      )}

      {/* Auto-hide */}
      <section className="space-y-3 rounded-md border p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <EyeOff className="h-4 w-4" /> Auto-hide comments
            </h3>
            <p className="text-xs text-muted-foreground">
              Hides matching comments as your Page or account. Hidden comments stay visible to the person who wrote them
              (and on Facebook their friends), so it doesn&apos;t start an argument. Nothing is deleted, and you can unhide
              any of them below.
            </p>
          </div>
          <Switch checked={autoHide} onCheckedChange={setAutoHide} disabled={!canEdit} aria-label="Auto-hide comments" data-testid="autohide-switch" />
        </div>
        <div className={cn("space-y-2", !autoHide && "opacity-60")}>
          <label className="block text-xs font-medium" htmlFor="blocked-words">
            Blocked words and phrases — one per line or separated by commas
          </label>
          <Textarea
            id="blocked-words"
            rows={4}
            value={wordsText}
            disabled={!canEdit}
            placeholder={"scam\nfree followers\nDM me"}
            className="text-sm"
            onChange={(e) => setWordsText(e.target.value)}
          />
          <p className="text-[11px] text-muted-foreground">
            Not case-sensitive. A single word matches only as a whole word (“ass” won&apos;t hide “class”); a phrase or emoji
            matches anywhere. {words.length > data.limits.maxWords && `Only the first ${data.limits.maxWords} are kept.`}
          </p>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={hideLinks} disabled={!canEdit} onChange={(e) => setHideLinks(e.target.checked)} />
            Also hide comments that contain a link
          </label>
          {noRule && <p className="text-[11px] text-amber-700 dark:text-amber-400">Add a word or tick “hide links” — auto-hide needs at least one rule.</p>}
          {cannotHide.length > 0 && (
            <p className="flex gap-1.5 text-[11px] text-amber-700 dark:text-amber-400" data-testid="cannot-hide">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              Can&apos;t hide on {cannotHide.map((a) => a.name).join(", ")} yet — their connection doesn&apos;t include the
              permission to moderate comments. Reconnect them on the Channels page (Edit settings, allow every permission).
            </p>
          )}
        </div>
      </section>

      {/* Alerts */}
      <section className="flex items-start justify-between gap-3 rounded-md border p-4">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Bell className="h-4 w-4" /> New-comment alerts
          </h3>
          <p className="text-xs text-muted-foreground">
            Owners and admins get one notification when new comments arrive on your recent posts, with a link to the
            Unanswered queue. At most one alert every 15 minutes.
          </p>
        </div>
        <Switch checked={alerts} onCheckedChange={setAlerts} disabled={!canEdit} aria-label="New-comment alerts" data-testid="alerts-switch" />
      </section>

      {/* Comment sentiment */}
      <section className="flex items-start justify-between gap-3 rounded-md border p-4">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Smile className="h-4 w-4" /> Comment sentiment
          </h3>
          <p className="text-xs text-muted-foreground">
            Scores each new comment on your recent posts as positive, neutral, mixed or negative, using the same AI
            scoring as Social Listening. See the results in Social Listening → Comments on your posts, and as a tag on
            each comment here. Also covers videos you publish to YouTube (sentiment only — the rules above and
            new-comment alerts don't apply there). Owners and admins get one alert when a check finds a burst of
            negative comments (at most one every 6 hours).
          </p>
        </div>
        <Switch
          checked={sentiment}
          onCheckedChange={setSentiment}
          disabled={!canEdit}
          aria-label="Comment sentiment"
          data-testid="sentiment-switch"
        />
      </section>

      {/* Scope */}
      <section className="space-y-2 rounded-md border p-4">
        <h3 className="text-sm font-semibold">Pages and accounts</h3>
        <div className="flex flex-wrap gap-4 text-xs">
          <label className="flex items-center gap-1.5">
            <input type="radio" name="automation-scope" checked={allAccounts} disabled={!canEdit} onChange={() => setAllAccounts(true)} />
            All Facebook Pages, Instagram accounts and YouTube channels ({data.accounts.length})
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" name="automation-scope" checked={!allAccounts} disabled={!canEdit} onChange={() => setAllAccounts(false)} />
            Only the ones I pick
          </label>
        </div>
        {!allAccounts && (
          <div className="grid max-h-56 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
            {data.accounts.map((a) => (
              <label key={a.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted">
                <input
                  type="checkbox"
                  checked={picked.has(a.id)}
                  disabled={!canEdit}
                  onChange={(e) =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(a.id);
                      else next.delete(a.id);
                      return next;
                    })
                  }
                />
                {a.platform === "YOUTUBE" ? (
                  <YouTubeIcon className="shrink-0" size={14} />
                ) : (
                  <PlatformGlyph platform={a.platform as CommentPlatform} className="shrink-0" />
                )}
                <span className="truncate">{a.name}</span>
                {a.sentimentOnly && (
                  <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]" title="Comment sentiment only — no auto-hide or alerts on YouTube">
                    Sentiment only
                  </Badge>
                )}
                {!a.isActive && <Badge variant="outline" className="h-4 px-1 text-[9px]">Paused</Badge>}
              </label>
            ))}
          </div>
        )}
        {scopeEmpty && <p className="text-[11px] text-amber-700 dark:text-amber-400">Pick at least one account, or choose “All”.</p>}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          disabled={!canEdit || save.isPending || noRule || scopeEmpty}
          onClick={() =>
            save.mutate({
              autoHideEnabled: autoHide,
              blockedWords: words,
              hideLinks,
              alertsEnabled: alerts,
              sentimentEnabled: sentiment,
              channelIds: allAccounts ? [] : [...picked],
            })
          }
          data-testid="automation-save"
        >
          {save.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          Save
        </Button>
        <p className="text-[11px] text-muted-foreground" data-testid="automation-last-run">
          Checks every 15 minutes, newest posts of the last 3 days first (up to 15 posts per run).{" "}
          {data.lastRunAt
            ? `Last run ${formatDistanceToNow(new Date(data.lastRunAt), { addSuffix: true })}: ${describeLastRun(summary)}`
            : "Hasn't run yet."}
        </p>
      </div>

      {/* Log */}
      <section className="space-y-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4" /> Hidden by your rules
        </h3>
        {logQuery.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : logQuery.isError ? (
          <p className="text-xs text-destructive">{humanizeError(logQuery.error)}</p>
        ) : (logQuery.data?.items.length ?? 0) === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">Nothing hidden yet.</p>
        ) : (
          <ul className="space-y-1.5" data-testid="autohide-log">
            {logQuery.data!.items.map((item) => (
              <li key={item.id} className="flex items-start gap-2 rounded-md border p-2 text-xs">
                <PlatformGlyph platform={item.platform} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-1.5">
                    <span className="font-medium">{item.authorLabel ?? "Someone"}</span>
                    <span className="text-muted-foreground">on {item.channelName ?? "a deleted channel"}</span>
                    <span className="text-muted-foreground">· {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}</span>
                    <Badge variant="outline" className="h-4 px-1.5 text-[10px]">{describeReason(item.reason)}</Badge>
                    {item.status === "UNHIDDEN" && <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">Unhidden</Badge>}
                  </p>
                  <p className="mt-0.5 break-words">{item.commentText || <em className="text-muted-foreground">No text</em>}</p>
                  {item.postCaption && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">Post: {item.postCaption}</p>}
                </div>
                {item.status === "HIDDEN" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0 px-2 text-xs"
                    disabled={unhidingId !== null}
                    onClick={() => {
                      setUnhidingId(item.id);
                      unhide.mutate({ targetId: item.postTargetId, commentId: item.commentId, action: "unhide" });
                    }}
                    title="Show this comment again — the automation won't hide it a second time"
                  >
                    {unhidingId === item.id && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                    Unhide
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
