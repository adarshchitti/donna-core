import { z } from 'zod';
import type { ObjectId } from 'mongodb';
import {
  type Briefing, type Change, type Cluster, type CollectorRun, type Coverage,
  type Schedule, type Signal, type Snapshot, type Source,
  dateOnly, isoInstant,
} from '@donna/contracts';

/**
 * Every write input is the contract type MINUS `book_id`.
 *
 * This is rule 1 enforced by the type system rather than by a comment: there is
 * no `book_id` field to pass, so there is no way to pass the wrong one. The
 * store holds a single `bookId` and stamps it itself. A document written with
 * the wrong book_id is invisible to Track C (every read filters
 * `{book_id: user.id}`) and produces a blank screen, never an error.
 */
export type WriteInput<T> = Omit<T, 'book_id'>;

// ---------------------------------------------------------------------------
// companies
// ---------------------------------------------------------------------------

/**
 * Note what is NOT here:
 *   - `book_id`      -- the store stamps it (rule 1).
 *   - `registry_key` -- derived from `registry_id` (rule 7); a hand-written one
 *                       would collide with the unique index.
 *   - `coverage`     -- must be written with `$set`, never through an upsert
 *                       that uses `$setOnInsert`. Use `setCoverage` (rule 3).
 *   - `resolution`   -- settable on insert only; use `setResolution` to change
 *                       it on an existing company (rule 5).
 */
export interface CompanyUpsertInput {
  /** Omit to mint a fresh crypto.randomUUID(), matching Track C's convention. */
  company_id?: string;
  canonical_name: string;
  /** 2-letter uppercase. Track C's linkDeal() throws on a country mismatch. */
  jurisdiction: string;
  /** '' (or omitted) means "no registry id", which yields a MANUAL: key. */
  registry_id?: string;
  aliases?: string[];
  domains?: string[];
  officers?: Record<string, unknown>[];
  related_entities?: Record<string, unknown>[];
  resolution?: {
    confidence: number | null;
    reason: string;
    resolved_by: string | null;
    candidates_seen?: Record<string, unknown>[];
    resolved_at?: string;
  };
  last_checked_at?: string;
  monitoring_since?: string;
  /** A pre-deal lookup. Written on insert only; see DonnaStore.upsertCompany. */
  lookup?: LookupInput;
}

export interface LookupInput {
  requested_at: string;
  requested_by: string;
  /** Date-only. Null for a one-shot lookup; a day for a bounded watch. */
  watch_until: string | null;
}

export interface CompanyUpsertResult {
  /** The id of the document that now holds this company -- NOT necessarily the
   *  id you passed in: a backfill merge prefers the canonical document. */
  company_id: string;
  outcome: 'inserted' | 'updated' | 'unchanged' | 'backfilled' | 'merged';
}

export interface ResolutionInput {
  confidence: number | null;
  reason: string;
  candidates_seen?: Record<string, unknown>[];
  /** Defaults to AUTO_RESOLVER. Pass an operator id for a human resolution. */
  resolved_by?: string;
}

export type BackfillOutcome =
  | { outcome: 'noop'; company_id: string }
  | { outcome: 'backfilled'; company_id: string; registry_key: string }
  | {
      outcome: 'merged';
      /** The surviving (canonical) company. */
      company_id: string;
      /** The MANUAL: document that was removed. */
      removed_company_id: string;
      registry_key: string;
      deals_moved: number;
    };

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------

export interface SnapshotInput extends Omit<WriteInput<Snapshot>, 'content_hash' | 'ok'> {
  /** Computed from `items` when omitted. */
  content_hash?: string;
  /**
   * Must be `true`. A failed fetch gets a `collector_runs` row with
   * status 'failed'; it never becomes a snapshot. Typed so the compiler says
   * so, and validated so a runtime `false` is rejected at the boundary.
   */
  ok: true;
}

export interface SnapshotInsertResult {
  snapshot_id: string;
  /** false means this snapshot_id already existed -- an idempotent no-op. */
  inserted: boolean;
}

// ---------------------------------------------------------------------------
// changes / signals / clusters / briefings
// ---------------------------------------------------------------------------

export type ChangeInput = WriteInput<Change>;

export interface SignalInput extends Omit<WriteInput<Signal>, 'signal_id'> {
  /** Defaults to signalId(company_id, type, first_seen). */
  signal_id?: string;
}

export interface SignalUpsertResult {
  signal_id: string;
  /** 'merged' means new evidence joined an existing signal in the 14-day window. */
  outcome: 'created' | 'merged';
}

export type ClusterInput = WriteInput<Cluster>;
export type BriefingInput = WriteInput<Briefing>;

// ---------------------------------------------------------------------------
// collector_runs
// ---------------------------------------------------------------------------

export interface RunStartInput {
  run_id: string;
  batch_id: string;
  company_id: string;
  source: Source;
  /** Defaults to now. */
  started_at?: string;
  sandbox_id?: string | null;
  cache_hit?: boolean;
}

/**
 * Handle returned by startRun.
 *
 * It carries `_id` because `run_id` is NOT unique: the contract mints it as
 * `run-<company_id>-<source>`, which repeats on every scheduled run of that
 * pair. Finishing a run by `run_id` alone would be ambiguous once a company has
 * been collected twice.
 */
export interface RunHandle {
  _id: ObjectId;
  run_id: string;
}

export interface RunFinishPatch {
  status: 'ok' | 'empty' | 'failed';
  error?: string | null;
  credits_spent?: number;
  ended_at?: string;
  cache_hit?: boolean;
  sandbox_id?: string | null;
}

export interface ReapResult {
  reaped: number;
  run_ids: string[];
  schedules_pushed: number;
}

// ---------------------------------------------------------------------------
// schedules
// ---------------------------------------------------------------------------

export interface ScheduleInput {
  company_id: string;
  source: Source;
  cadence: 'daily' | 'weekly';
  next_run_at: string;
  last_run_at?: string | null;
  enabled?: boolean;
  /** Null (the default) for monitoring; an instant for a bounded lookup watch. */
  expires_at?: string | null;
}

// ---------------------------------------------------------------------------
// fetch_cache -- our collection, so the contract lives here.
// ---------------------------------------------------------------------------

export const fetchCacheEntrySchema = z.object({
  book_id: z.string().min(1),
  /** "<YYYY-MM-DD>|<url>" -- the URL-plus-UTC-day key from the architecture. */
  cache_key: z.string().min(1),
  url: z.string().min(1),
  utc_day: dateOnly,
  payload: z.unknown(),
  credits_spent: z.number().int().min(0),
  created_at: isoInstant,
  /** A BSON Date, not a string: Mongo's TTL monitor ignores string fields. */
  expires_at: z.date(),
});
export type FetchCacheEntry = z.infer<typeof fetchCacheEntrySchema>;

export interface PutCachedOptions {
  /** Defaults to today (UTC). */
  day?: string;
  /** Defaults to FETCH_CACHE_TTL_HOURS. */
  ttlHours?: number;
  credits_spent?: number;
}

export type { Coverage, Schedule, CollectorRun };
