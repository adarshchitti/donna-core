/**
 * @donna/store -- the only way this codebase talks to MongoDB.
 *
 * The database is shared with a live Base44 app ("Track C") that owns
 * `companies`, `deals` and `donna_auth_links`. Read `constants.ts` and
 * `indexes.ts` before changing anything here: at this boundary a wrong field
 * name or a missing `book_id` produces a blank screen in someone else's app,
 * not an exception in ours.
 */
export { DonnaStore, type DonnaStoreOptions } from './store.js';
export { StoreError, StoreValidationError, validate } from './validate.js';
export {
  AUTO_RESOLVER, MANUAL_REGISTRY_PREFIX, SIGNAL_WINDOW_DAYS, STALE_RUN_MINUTES,
  FETCH_CACHE_TTL_HOURS, COLLECTIONS, DONNA_COLLECTIONS, TRACK_C_COLLECTIONS,
} from './constants.js';
export {
  ALL_INDEXES, DONNA_INDEXES, TRACK_C_INDEXES, ensureIndexes, type IndexDef,
} from './indexes.js';
export {
  addDays, contentHash, isManualRegistryKey, registryKeyFor, sameName,
  toUtcDay, toUtcInstant,
} from './util.js';
export type {
  BackfillOutcome, BriefingInput, ChangeInput, ClusterInput, CompanyUpsertInput,
  CompanyUpsertResult, FetchCacheEntry, LookupInput, PutCachedOptions, ReapResult,
  ResolutionInput, RunFinishPatch, RunHandle, RunStartInput, ScheduleInput,
  SignalInput, SignalUpsertResult, SnapshotInput, SnapshotInsertResult, WriteInput,
} from './types.js';
export { fetchCacheEntrySchema } from './types.js';
