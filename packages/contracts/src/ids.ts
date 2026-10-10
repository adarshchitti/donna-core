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

export const runId = (companyId: string, source: Source): string =>
  `run-${companyId}-${source}`;

export const snapshotId = (companyId: string, source: Source): string =>
  `snap-${companyId}-${source}`;

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
