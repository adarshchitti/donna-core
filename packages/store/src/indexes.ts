import type { Db, IndexSpecification, CreateIndexesOptions } from 'mongodb';
import { COLLECTIONS } from './constants.js';

/**
 * ===========================================================================
 * THE INDEX-CONFLICT HAZARD -- read this before changing anything below.
 * ===========================================================================
 *
 * Track C calls `createIndex` on `companies` and `deals` on EVERY request.
 * `createIndex` is idempotent only when the key spec, the name AND the options
 * all match an existing index. If any of them differ, Mongo raises
 * `IndexOptionsConflict` -- and Track C swallows that into a generic 503. The
 * symptom is "all of Track C's writes fail with an unhelpful message", and the
 * cause is a one-word difference in a file nobody is looking at.
 *
 * Therefore, for indexes on collections Track C touches (`companies`, `deals`)
 * we pass ONLY the key spec plus `{unique: true}` where Track C uses it, and we
 * NEVER pass an explicit `name`. Mongo then generates the same default name
 * Track C's call generates ("book_id_1_jurisdiction_1_registry_key_1" etc.) and
 * both calls are no-ops for each other.
 *
 * This is also why our extra `deals` index gets the DEFAULT name rather than a
 * `donna_`-prefixed one: if Track C ever adds `{book_id, company_id}` itself,
 * a default-named index of ours is a no-op for it, whereas a custom-named one
 * would be a hard conflict.
 *
 * For collections only we use, Track C never calls createIndex, so we name them
 * explicitly with a `donna_` prefix. That makes ownership obvious in
 * `db.collection.getIndexes()` and guarantees the names cannot collide with
 * anything Track C generates.
 */

export interface IndexDef {
  readonly collection: string;
  readonly keys: IndexSpecification;
  readonly options?: CreateIndexesOptions;
  /** Why this index exists -- an index with no stated query is dead weight. */
  readonly why: string;
}

/**
 * Indexes Track C ALREADY HAS. We declare them so a fresh database (local, CI,
 * or a new Atlas cluster) comes up identical to production -- not to "fix"
 * anything on the live cluster, where these calls are deliberate no-ops.
 *
 * Verified against the live cluster's index names:
 *   companies: book_id_1_jurisdiction_1_registry_key_1 (unique),
 *              book_id_1_company_id_1 (unique)
 *   deals:     book_id_1_created_date_-1_deal_id_-1,
 *              book_id_1_status_1_company_id_1
 */
export const TRACK_C_INDEXES: readonly IndexDef[] = [
  {
    collection: COLLECTIONS.companies,
    keys: { book_id: 1, jurisdiction: 1, registry_key: 1 },
    options: { unique: true },
    why: 'The key companies are upserted on. registry_key is registry_id uppercased, or MANUAL:<uuid>.',
  },
  {
    collection: COLLECTIONS.companies,
    keys: { book_id: 1, company_id: 1 },
    options: { unique: true },
    why: 'company_id is the handle every other collection joins on.',
  },
  {
    collection: COLLECTIONS.deals,
    keys: { book_id: 1, created_date: -1, deal_id: -1 },
    why: "Track C's deal list ordering.",
  },
  {
    collection: COLLECTIONS.deals,
    keys: { book_id: 1, status: 1, company_id: 1 },
    why: "Track C's unresolved/needs_review queues.",
  },
];

/** Indexes we add. Default names on Track C's collections, `donna_` on ours. */
export const DONNA_INDEXES: readonly IndexDef[] = [
  {
    collection: COLLECTIONS.deals,
    keys: { book_id: 1, company_id: 1 },
    // No explicit name on purpose -- see the header comment.
    why: 'Deals-by-company without a status predicate. Track C lacks this, so our '
      + 'cluster build would collection-scan deals for every company.',
  },

  // --- snapshots -----------------------------------------------------------
  {
    collection: COLLECTIONS.snapshots,
    keys: { book_id: 1, company_id: 1, source: 1, fetched_at: -1 },
    options: { name: 'donna_snapshots_baseline' },
    why: 'THE baseline lookup: newest ok snapshot per (company, source). The differ '
      + 'runs this once per collector run, so it must be an index hit.',
  },
  {
    collection: COLLECTIONS.snapshots,
    keys: { book_id: 1, snapshot_id: 1 },
    options: { name: 'donna_snapshots_snapshot_id', unique: true },
    why: 'Snapshots are immutable and insert-only; uniqueness is what makes a '
      + 're-insert of the same snapshot_id a no-op instead of a duplicate.',
  },

  // --- changes -------------------------------------------------------------
  {
    collection: COLLECTIONS.changes,
    keys: { book_id: 1, company_id: 1, detected_at: -1 },
    options: { name: 'donna_changes_recent' },
    why: 'Recent changes per company, for the validator window.',
  },
  {
    collection: COLLECTIONS.changes,
    keys: { book_id: 1, snapshot_id: 1 },
    options: { name: 'donna_changes_by_snapshot' },
    why: 'Evidence drill-down from a snapshot to the changes it produced.',
  },

  // --- signals -------------------------------------------------------------
  {
    collection: COLLECTIONS.signals,
    keys: { book_id: 1, company_id: 1, type: 1, first_seen: 1 },
    options: { name: 'donna_signals_corroboration' },
    why: 'THE corroboration key. Signals are upserted by (company, type, 14-day '
      + 'window), which is exactly a range scan on first_seen under this prefix.',
  },
  {
    collection: COLLECTIONS.signals,
    keys: { book_id: 1, signal_id: 1 },
    options: { name: 'donna_signals_signal_id', unique: true },
    why: 'signal_id encodes (company, type, window start), so it IS the identity.',
  },
  {
    collection: COLLECTIONS.signals,
    keys: { book_id: 1, company_id: 1, tier: -1, first_seen: -1 },
    options: { name: 'donna_signals_by_tier' },
    why: 'Highest-tier signals first, for the briefing headline.',
  },

  // --- clusters ------------------------------------------------------------
  {
    collection: COLLECTIONS.clusters,
    keys: { book_id: 1, cluster_id: 1 },
    options: { name: 'donna_clusters_cluster_id', unique: true },
    why: 'One cluster per company per mode; cluster_id is cl-<company_id>.',
  },
  {
    collection: COLLECTIONS.clusters,
    keys: { book_id: 1, company_id: 1, mode: 1 },
    options: { name: 'donna_clusters_by_company' },
    why: 'Narrator input lookup.',
  },

  // --- briefings -----------------------------------------------------------
  {
    collection: COLLECTIONS.briefings,
    keys: { book_id: 1, briefing_id: 1 },
    options: { name: 'donna_briefings_briefing_id', unique: true },
    why: 'br-<company_id> / profile-<company_id> are the ids Track C links to.',
  },
  {
    collection: COLLECTIONS.briefings,
    keys: { book_id: 1, company_id: 1, mode: 1, generated_at: -1 },
    options: { name: 'donna_briefings_latest' },
    why: 'Newest briefing per (company, mode) for the surface.',
  },

  // --- collector_runs ------------------------------------------------------
  {
    collection: COLLECTIONS.collectorRuns,
    keys: { book_id: 1, batch_id: 1 },
    options: { name: 'donna_runs_batch' },
    why: "Track C's SourceTable filters on batch-<company_id>-<YYYY-MM-DD>.",
  },
  {
    collection: COLLECTIONS.collectorRuns,
    keys: { book_id: 1, status: 1, started_at: 1 },
    options: { name: 'donna_runs_reaper' },
    why: 'The stale-run reaper scans {status: "started", started_at: {$lt: cutoff}}.',
  },
  {
    collection: COLLECTIONS.collectorRuns,
    keys: { book_id: 1, company_id: 1, source: 1, started_at: -1 },
    options: { name: 'donna_runs_latest' },
    why: 'Latest run per (company, source) -- the coverage matrix cell.',
  },
  {
    collection: COLLECTIONS.collectorRuns,
    keys: { book_id: 1, run_id: 1, started_at: -1 },
    // NOT unique. @donna/contracts mints two forms: `runId()` is the alias
    // `run-<company_id>-<source>` that Track C's Coverage.jsx builds to mean
    // "the latest run of this pair", and `runIdAt()` is the unique-per-run
    // form. A unique index here would reject the second run of any pair.
    options: { name: 'donna_runs_run_id' },
    why: 'Resolve a run_id to its newest document.',
  },

  // --- schedules -----------------------------------------------------------
  {
    collection: COLLECTIONS.schedules,
    keys: { book_id: 1, next_run_at: 1 },
    options: { name: 'donna_schedules_due' },
    why: 'The orchestrator loop IS the scheduler: it polls next_run_at <= now.',
  },
  {
    collection: COLLECTIONS.schedules,
    keys: { book_id: 1, company_id: 1, source: 1 },
    options: { name: 'donna_schedules_identity', unique: true },
    why: 'Exactly one schedule per (company, source). Uniqueness prevents a '
      + 'duplicate schedule quietly doubling our credit spend.',
  },

  // --- fetch_cache ---------------------------------------------------------
  {
    collection: COLLECTIONS.fetchCache,
    keys: { book_id: 1, cache_key: 1 },
    options: { name: 'donna_fetch_cache_key', unique: true },
    why: 'cache_key is "<YYYY-MM-DD>|<url>" -- the URL-plus-UTC-day key the '
      + 'architecture specifies. Uniqueness is what makes the cache a cache.',
  },
  {
    collection: COLLECTIONS.fetchCache,
    keys: { expires_at: 1 },
    options: { name: 'donna_fetch_cache_ttl', expireAfterSeconds: 0 },
    // expires_at is stored as a BSON Date, not an ISO string: Mongo's TTL
    // monitor ignores string fields silently, which would leave the cache to
    // grow forever with no error anywhere.
    why: 'TTL reaper. Not book-scoped because a TTL index may only have one key.',
  },
];

export const ALL_INDEXES: readonly IndexDef[] = [...TRACK_C_INDEXES, ...DONNA_INDEXES];

/**
 * Create every index. Safe to call repeatedly and concurrently with Track C,
 * which is the point: each call is either a no-op or a creation, never a
 * conflict.
 */
export async function ensureIndexes(db: Db, defs: readonly IndexDef[] = ALL_INDEXES): Promise<void> {
  for (const def of defs) {
    await db.collection(def.collection).createIndex(def.keys, def.options ?? {});
  }
}
