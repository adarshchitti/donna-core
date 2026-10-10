/**
 * Names and sentinels that are shared with another team's live database.
 *
 * A Base44 app ("Track C") reads and writes the same MongoDB. It owns
 * `companies`, `deals` and `donna_auth_links`; we own everything else. Every
 * mistake at this boundary fails SILENTLY -- Track C filters every read on
 * `{book_id: user.id}`, so a wrong field name or a missing `book_id` renders a
 * blank screen rather than raising an error. The constants here exist so that
 * those strings are written down exactly once.
 */

/** Collections Track C already owns. We write into them; we never rename them. */
export const TRACK_C_COLLECTIONS = {
  companies: 'companies',
  deals: 'deals',
  /** Track C's own auth table. Listed so it is obvious we must never touch it. */
  authLinks: 'donna_auth_links',
} as const;

/** Collections this package introduces. Track C never calls createIndex on these. */
export const DONNA_COLLECTIONS = {
  snapshots: 'snapshots',
  changes: 'changes',
  signals: 'signals',
  clusters: 'clusters',
  briefings: 'briefings',
  collectorRuns: 'collector_runs',
  schedules: 'schedules',
  fetchCache: 'fetch_cache',
} as const;

export const COLLECTIONS = { ...TRACK_C_COLLECTIONS, ...DONNA_COLLECTIONS } as const;

/**
 * Sentinel for `companies.resolution.resolved_by`.
 *
 * Anything Donna resolves without a human in the loop carries this value, so an
 * automated guess can always be told apart from a user's deliberate choice. A
 * human resolution writes a different value (an operator id / email); never
 * overwrite one with this.
 */
export const AUTO_RESOLVER = 'auto_resolver';

/**
 * Prefix Track C uses for `registry_key` when a company was added by hand and
 * has no registry id: `MANUAL:<uuid>`. See DonnaStore.backfillRegistryId for
 * why discovering a real registry id for one of these is not a plain `$set`.
 */
export const MANUAL_REGISTRY_PREFIX = 'MANUAL:';

/**
 * Corroboration window, in days. Signals are upserted by
 * (company, type, 14-day window): a second observation of the same type inside
 * the window is MORE EVIDENCE for the same signal, not a new signal.
 */
export const SIGNAL_WINDOW_DAYS = 14;

/** A collector run still `started` after this long is considered dead. */
export const STALE_RUN_MINUTES = 10;

/** Default lifetime of a fetch_cache entry (the architecture caches per UTC day). */
export const FETCH_CACHE_TTL_HOURS = 24;
