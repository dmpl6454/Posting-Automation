import { prisma } from "@postautomation/db";
import type { PublishingHealth } from "@postautomation/queue";
import { computePublishingHealth } from "./publishing-health";
import { sendEmail } from "./email";

/**
 * "Publishing has stopped" email (2026-11-12).
 *
 * Runs inside the WEB process (started from apps/web/instrumentation-node.ts),
 * because the worker is the thing that dies. On 2026-11-10 nothing published
 * for ~33 hours and nobody was told.
 *
 * - Checks every CHECK_INTERVAL_MS; alerts only after CONSECUTIVE_BAD bad
 *   verdicts in a row, so a single slow check during a deploy never emails.
 * - While still bad, repeats at most every REPEAT_MS.
 * - Sends one "publishing resumed" email when it recovers after an alert.
 * - Recipients: every super admin, plus PUBLISHING_ALERT_EMAIL (comma list).
 * - State is in memory on purpose: Redis may be the broken part.
 * - Kill switch: PUBLISHING_ALERTS_ENABLED=false.
 */

export const CHECK_INTERVAL_MS = 5 * 60 * 1000;
export const FIRST_CHECK_DELAY_MS = 3 * 60 * 1000;
export const CONSECUTIVE_BAD = 2;
export const REPEAT_MS = 6 * 60 * 60 * 1000;

export interface AlertState {
  badStreak: number;
  alertedAt: number | null;
}

export type AlertAction = "none" | "alert" | "recover";

/** Pure decision. `unknown` counts as bad: a check that cannot see anything must not read as "fine". */
export function nextAlertAction(
  state: AlertState,
  health: Pick<PublishingHealth, "status">,
  now: number
): { action: AlertAction; state: AlertState } {
  if (health.status === "ok") {
    if (state.alertedAt !== null) return { action: "recover", state: { badStreak: 0, alertedAt: null } };
    return { action: "none", state: { badStreak: 0, alertedAt: null } };
  }
  const badStreak = state.badStreak + 1;
  if (badStreak < CONSECUTIVE_BAD) return { action: "none", state: { ...state, badStreak } };
  if (state.alertedAt === null || now - state.alertedAt >= REPEAT_MS) {
    return { action: "alert", state: { badStreak, alertedAt: now } };
  }
  return { action: "none", state: { ...state, badStreak } };
}

export function alertRecipients(superAdminEmails: string[], extra: string | undefined): string[] {
  const all = [...superAdminEmails, ...(extra ?? "").split(",")]
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  return [...new Set(all)];
}

export function buildAlertEmail(kind: "alert" | "recover", health: PublishingHealth): { subject: string; text: string } {
  if (kind === "recover") {
    return {
      subject: "✅ PostAutomation: publishing has resumed",
      text: [
        "Publishing is running again.",
        "",
        "Posts that were scheduled during the outage are sent automatically once the worker is back.",
        "Check Content Studio for anything you would rather not publish late.",
      ].join("\n"),
    };
  }
  const lines = [
    `Status: ${health.status.toUpperCase()}`,
    health.reason,
    health.heartbeatAgeSec !== null ? `Last worker scan: ${Math.round(health.heartbeatAgeSec / 60)} min ago` : null,
    health.overduePosts !== null ? `Scheduled posts past their time: ${health.overduePosts}` : null,
    health.oldestOverdueMinutes !== null ? `Oldest is ${health.oldestOverdueMinutes} min late` : null,
    "",
    "On the server:",
    "  docker ps --format \"table {{.Names}}\\t{{.Status}}\"",
    "  docker logs postautomation-worker-1 --tail 50",
    "",
    "A worker that shows Restarting is crash-looping; its log names the error.",
  ].filter((l): l is string => l !== null);
  return { subject: "🚨 PostAutomation: posts are NOT publishing", text: lines.join("\n") };
}

let started = false;

export function isPublishingAlertsEnabled(): boolean {
  return process.env.PUBLISHING_ALERTS_ENABLED !== "false" && process.env.NODE_ENV === "production";
}

/** Start the watcher once per process. Never throws. */
export function startPublishingAlerts(): void {
  if (started || !isPublishingAlertsEnabled()) return;
  started = true;
  let state: AlertState = { badStreak: 0, alertedAt: null };

  const tick = async () => {
    try {
      const health = await computePublishingHealth();
      const next = nextAlertAction(state, health, Date.now());
      state = next.state;
      if (health.status !== "ok") console.warn(`[publishing-health] ${health.status}: ${health.reason}`);
      if (next.action === "none") return;

      const admins = await prisma.user
        .findMany({ where: { isSuperAdmin: true }, select: { email: true } })
        .then((rows) => rows.map((r) => r.email ?? "").filter(Boolean))
        .catch(() => [] as string[]);
      const to = alertRecipients(admins, process.env.PUBLISHING_ALERT_EMAIL);
      if (to.length === 0) {
        console.error("[publishing-health] no alert recipient (no super admin, PUBLISHING_ALERT_EMAIL unset)");
        return;
      }
      const email = buildAlertEmail(next.action, health);
      for (const addr of to) {
        await sendEmail({ to: addr, subject: email.subject, text: email.text, html: `<pre>${escapeHtml(email.text)}</pre>` });
      }
      console.warn(`[publishing-health] sent ${next.action} email to ${to.length} recipient(s)`);
    } catch (err) {
      console.error("[publishing-health] check failed:", err instanceof Error ? err.message : err);
    }
  };

  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), CHECK_INTERVAL_MS).unref?.();
  }, FIRST_CHECK_DELAY_MS).unref?.();
  console.log("[publishing-health] alert watcher on");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
