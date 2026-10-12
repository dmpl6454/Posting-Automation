/**
 * "YYYY-MM-DDTHH:mm" in the browser's LOCAL time — the format DateTimePicker
 * (and a native datetime-local input) reads and writes.
 *
 * ⚠️ Never seed the picker from `date.toISOString().slice(0, 16)`: that is the
 * UTC clock face, and the picker treats its value as LOCAL. For a user at
 * UTC+5:30 a post scheduled for 18:30 IST showed as 13:00, and any Save on the
 * post page (even a caption edit) then re-sent that wrong value and moved the
 * real schedule 5½ hours EARLIER — into the past when the gap was short, so
 * the post published at once or the save was refused (2026-10-10, owner:
 * "schedule doesn't work properly"). The same UTC string as a `min` disables
 * "today" in the calendar for anyone west of UTC once their evening starts.
 */
const pad = (n: number) => String(n).padStart(2, "0");

export function toLocalDateTimeInput(value: Date | string | number | null | undefined): string {
  if (value == null || value === "") return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The picker's lower bound for "no earlier than now", in local time. */
export function nowLocalDateTimeInput(now: Date = new Date()): string {
  return toLocalDateTimeInput(now);
}

/**
 * Why a Compose "Schedule" click cannot go through yet, or null (2026-10-12).
 * The Schedule button used to be DISABLED until a time was picked in the
 * separate Schedule box — greyed out with no reason a phone could show, which
 * read as "the schedule option is gone". It now stays clickable and this names
 * the fix instead. Same 60s skew allowance as the server.
 */
export function scheduleTimeProblem(value: string, now: number = Date.now()): string | null {
  if (!value) return "Pick a date and time in the Schedule box first.";
  const at = new Date(value).getTime();
  if (Number.isNaN(at)) return "Pick a date and time in the Schedule box first.";
  if (at < now - 60_000) return "That time has already passed — pick a later time.";
  return null;
}

/**
 * The time a freshly picked DATE should get when no time is chosen yet: the
 * next full hour (as before). For TODAY after 23:00 that hour is tomorrow's
 * 00:00 — the picker used `(now.getHours() + 1) % 24` on today's date, which
 * set TODAY 00:00, a time already in the past.
 */
export function defaultTimeForDate(date: Date, now: Date = new Date()): { date: Date; hour: number; minute: number } {
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (!sameDay) return { date, hour: (now.getHours() + 1) % 24, minute: 0 };
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0);
  return { date: new Date(next.getFullYear(), next.getMonth(), next.getDate()), hour: next.getHours(), minute: 0 };
}
