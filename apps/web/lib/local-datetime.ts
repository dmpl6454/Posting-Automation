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
