import { createHash } from 'node:crypto';
import { StoreError } from './validate.js';
import { MANUAL_REGISTRY_PREFIX } from './constants.js';

/**
 * Normalise an instant to UTC `...Z` form.
 *
 * WHY: the contract's `isoInstant` accepts an offset ("2026-01-01T00:00:00+05:30"),
 * but we do RANGE QUERIES on these fields (the stale-run reaper on `started_at`,
 * the scheduler on `next_run_at`). Mongo compares strings byte-wise, so a mixed
 * set of offsets sorts wrongly and the reaper silently skips runs. Every instant
 * we write goes through here first.
 */
export function toUtcInstant(value: string | Date): string {
  // A date-only string in an instant field is a contract violation, not
  // something to quietly widen: Track C's dateLabel() does
  // new Date(v + 'T12:00:00Z'), so the two field families are not
  // interchangeable in either direction and the symptom is "Invalid Date".
  if (typeof value === 'string' && !value.includes('T')) {
    throw new StoreError(
      `Expected a full ISO instant (e.g. 2026-03-01T10:00:00.000Z), got ${JSON.stringify(value)}.`,
    );
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new StoreError(`Not a parseable instant: ${JSON.stringify(value)}`);
  }
  return d.toISOString();
}

/** YYYY-MM-DD in UTC. */
export function toUtcDay(value: string | Date = new Date()): string {
  return toUtcInstant(value instanceof Date ? value : `${value}`).slice(0, 10);
}

/** Add days to a YYYY-MM-DD date-only string, staying in UTC. */
export function addDays(day: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new StoreError(`Expected YYYY-MM-DD, got ${JSON.stringify(day)}`);
  }
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * `registry_key` exactly as Track C computes it: the registry id uppercased, or
 * `MANUAL:<uuid>` when there is none. It is part of the unique index
 * {book_id, jurisdiction, registry_key}, so getting this wrong either creates a
 * duplicate company or collides with someone else's.
 */
export function registryKeyFor(registryId: string, manualUuid: () => string): string {
  const trimmed = registryId.trim();
  return trimmed ? trimmed.toUpperCase() : `${MANUAL_REGISTRY_PREFIX}${manualUuid()}`;
}

export function isManualRegistryKey(key: string): boolean {
  return key.startsWith(MANUAL_REGISTRY_PREFIX);
}

/**
 * Track C 409s on a case-insensitive canonical_name mismatch, so "same name"
 * has to mean the same thing here that it means there.
 */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Stable content hash over a collector's items, for change detection. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

/** Mongo's duplicate-key error. Used to turn a racing insert into a no-op. */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}
