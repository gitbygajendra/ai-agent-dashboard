import { formatDate } from "@/lib/utils";

/** Format a date-only value ("YYYY-MM-DD") without shifting it across timezones. */
export function formatDay(value: string | null | undefined) {
  if (!value) return "—";
  const d = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? value : formatDate(d);
}

export function isOverdue(due: string | null | undefined) {
  if (!due) return false;
  return new Date(due).getTime() < Date.now();
}

export type DueBucket = "overdue" | "today" | "upcoming" | "none";

export function dueBucket(due: string | null | undefined): DueBucket {
  if (!due) return "none";
  const d = new Date(due);
  const now = new Date();
  if (d.getTime() < now.getTime()) return "overdue";
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  return d.getTime() <= endOfToday.getTime() ? "today" : "upcoming";
}

/** Convert a <input type="datetime-local"> value (local time) to an ISO string with offset. */
export function localInputToIso(value: string) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
