import type { Source } from './enums.js';

/**
 * Document id conventions.
 *
 * These are NOT free choices. Track C's Coverage.jsx and SourceTable.jsx mint
 * ids client-side to build evidence links:
 *   Coverage.jsx   -> `run-${company_id}-${sourceId(label)}`, `snap-${company_id}-${sourceId(label)}`
 *   SourceTable.jsx -> filters on `batch-${company_id}-${YYYY-MM-DD}`
 * So A2 must reproduce them exactly for the latest run per (company, source),
 * or those links 404.
 */

/**
 * Track C's Coverage.jsx mints `run-<company>-<source>` for the latest run of a
 * pair, so that form is preserved as the alias. A run that needs a unique id
 * (every run, once history matters) uses runIdAt.
 */
export const runId = (companyId: string, source: Source): string =>
  `run-${companyId}-${source}`;

export const runIdAt = (companyId: string, source: Source, startedAt: string): string =>
  `run-${companyId}-${source}-${startedAt.replace(/[:.]/g, '')}`;

/**
 * The alias form Track C's Coverage.jsx mints client-side to link to the LATEST
 * snapshot for a (company, source). No document carries this id; `getEvidence`
 * resolves it by falling back to the newest ok snapshot for that pair. Keeping
 * the alias means snapshot ids can be unique without touching the frontend.
 */
export const latestSnapshotAlias = (companyId: string, source: Source): string =>
  `snap-${companyId}-${source}`;

/**
 * A snapshot id must be UNIQUE PER FETCH, because snapshots are immutable and we
 * keep every one -- three years of officer lists is a churn pattern, one officer
 * list is a fact. An id of `snap-<company>-<source>` would collide on every run,
 * which would also make change.snapshot_id and change.baseline_id the SAME
 * string on every change, leaving no way to open the page a claim rests on.
 */
export const snapshotId = (
  companyId: string,
  source: Source,
  fetchedAt?: string,
): string =>
  fetchedAt === undefined
    ? latestSnapshotAlias(companyId, source)
    : `snap-${companyId}-${source}-${fetchedAt.replace(/[:.]/g, '')}`;

/** Parses the alias form back into its parts, or null if it is a real id. */
export const parseLatestSnapshotAlias = (
  id: string,
): { companyId: string; source: string } | null => {
  const m = /^snap-(.+)-([a-z]+)$/.exec(id);
  if (!m || !m[1] || !m[2]) return null;
  return { companyId: m[1], source: m[2] };
};

/** utcDay must be YYYY-MM-DD. */
export const batchId = (companyId: string, utcDay: string): string =>
  `batch-${companyId}-${utcDay}`;

export const clusterId = (companyId: string): string => `cl-${companyId}`;
export const briefingId = (companyId: string): string => `br-${companyId}`;
export const profileBriefingId = (companyId: string): string => `profile-${companyId}`;

/** Signals are upserted by (company, type, window), so the id encodes that key. */
export const signalId = (companyId: string, type: string, windowFrom: string): string =>
  `sig-${companyId}-${type}-${windowFrom}`;

export const utcDay = (d: Date = new Date()): string => d.toISOString().slice(0, 10);

/** Full ISO instant, for generated_at / fetched_at / detected_at. */
export const isoNow = (d: Date = new Date()): string => d.toISOString();

/** The cache key the architecture specifies: URL plus UTC day. */
export const fetchCacheKey = (url: string, day: string = utcDay()): string =>
  `${day}|${url}`;
