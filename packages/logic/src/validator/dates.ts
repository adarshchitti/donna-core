/**
 * Date arithmetic on date-only strings.
 *
 * WHY date-only everywhere: Track C's dateLabel() does
 * new Date(v + 'T12:00:00Z'), so a full ISO instant in first_seen or
 * window.from renders "Invalid Date". These helpers only ever return
 * YYYY-MM-DD, and parsing is pinned to UTC noon so a local timezone can never
 * shift a day.
 */

const DAY_MS = 86_400_000;

export const isDateOnly = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Accepts a date-only string or a full ISO instant; returns the UTC day. */
export const toDateOnly = (s: string): string => s.slice(0, 10);

const asUtcMs = (dateOnly: string): number =>
  Date.parse(`${toDateOnly(dateOnly)}T12:00:00Z`);

/** b - a, in whole days. Positive when b is later. */
export const daysBetween = (a: string, b: string): number =>
  Math.round((asUtcMs(b) - asUtcMs(a)) / DAY_MS);

export const addDays = (dateOnly: string, days: number): string =>
  new Date(asUtcMs(dateOnly) + days * DAY_MS).toISOString().slice(0, 10);

/** Absolute day distance, which is what the corroboration window cares about. */
export const daysApart = (a: string, b: string): number => Math.abs(daysBetween(a, b));
