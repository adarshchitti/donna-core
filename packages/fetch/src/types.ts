/**
 * The seam the whole system fetches through.
 *
 * Bright Data is the SOLE fetch path for Donna: no collector, no orchestrator
 * step and no script may call bare `fetch()` against a target site. That is an
 * architectural rule, so it has to be cheap to obey -- hence one interface with
 * an offline implementation, which is what lets every other package be built
 * and tested with no credentials and no network.
 */

import { z } from 'zod';

/**
 * - `live`    real HTTP to Bright Data, nothing written to disk.
 * - `record`  real HTTP, and the response is written to a cassette.
 * - `replay`  cassettes only; a miss throws. Never touches the network.
 */
export const fetchModeSchema = z.enum(['live', 'record', 'replay']);
export type FetchMode = z.infer<typeof fetchModeSchema>;

/**
 * Why `replay` is the default when DONNA_FETCH_MODE is unset: credits are a
 * hard, shared, non-renewable budget (300 for the entire event) and a careless
 * `npm test`, a stray script or a CI run must not be able to spend one or make
 * a network call. Going live is therefore an explicit, deliberate act -- you
 * set the variable. Failing closed costs a confusing cassette-miss error;
 * failing open costs the budget.
 */
export const DEFAULT_FETCH_MODE: FetchMode = 'replay';

/** What every fetch through this layer returns. `credits_spent` is per call. */
export interface FetchResult {
  body: string;
  url: string;
  fetched_at: string;
  credits_spent: number;
  cache_hit: boolean;
}

export type SerpEngine = 'google' | 'bing';

export interface SerpOptions {
  engine?: SerpEngine;
  num?: number;
}

/** One organic result parsed out of SERP HTML. `rank` is 1-based. */
export interface SerpResult {
  url: string;
  title: string;
  rank: number;
}

/** A SERP fetch plus its parsed organic results. */
export interface SerpPage extends FetchResult {
  results: SerpResult[];
}

export interface BrightDataClient {
  /** Web Unlocker: fetch a target page through BRIGHTDATA_UNLOCKER_ZONE. */
  unlocker(url: string): Promise<FetchResult>;
  /** SERP: run a search-engine query through BRIGHTDATA_SERP_ZONE. */
  serp(query: string, opts?: SerpOptions): Promise<FetchResult>;
  /**
   * `serp` plus the parsed organic results, so a collector can do
   * "SERP first, page fetch only for genuinely new result URLs".
   */
  serpResults(query: string, opts?: SerpOptions): Promise<SerpPage>;
  /** Cumulative credits spent by this client instance. */
  creditsSpent(): number;
}

// ---------------------------------------------------------------------------
// Cassette / fetch cache
// ---------------------------------------------------------------------------

/**
 * A recorded response.
 *
 * `url` and `day` are stored alongside `key` on purpose: the on-disk filename
 * is a sha256 of the key (filesystem safety -- target URLs contain `/`, `?`,
 * `&`, and run past path length limits), so without this sidecar a human
 * staring at `fixtures/cassettes/3f2a....json` could not tell what it is.
 */
export const cassetteSchema = z.object({
  /** `${utcDay}|${url}`, exactly `fetchCacheKey()` from @donna/contracts. */
  key: z.string().min(1),
  /** Sidecar: the original target URL, for humans reading the directory. */
  url: z.string().min(1),
  /** The UTC day the key was computed on, YYYY-MM-DD. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
  /** Which Bright Data zone produced it: the unlocker or the SERP zone. */
  zone: z.string(),
  /** HTTP status Bright Data returned. */
  status: z.number().int(),
  /** ISO instant the recording was made. */
  fetched_at: z.string().min(1),
  body: z.string(),
});
export type Cassette = z.infer<typeof cassetteSchema>;

/**
 * The fetch cache, as an interface.
 *
 * The cassette key IS the fetch cache key (URL + UTC day), which is deliberate:
 * the architecture specifies a `fetch_cache` keyed by URL plus UTC day, and
 * this on-disk store and the later Mongo-backed one are two BACKENDS OF ONE
 * INTERFACE, not two mechanisms. A same-day re-run therefore costs zero
 * credits whichever backend is mounted, and swapping in Mongo touches no
 * client code.
 */
export interface CassetteStore {
  get(key: string): Promise<Cassette | undefined>;
  put(cassette: Cassette): Promise<void>;
  /**
   * Where this key lives, for error messages. A file store returns a path; a
   * Mongo store would return something like `mongo://donna.fetch_cache/<id>`.
   */
  locate(key: string): string;
}

// ---------------------------------------------------------------------------
// Injected HTTP
// ---------------------------------------------------------------------------

/**
 * The minimum of `fetch` this package uses. Tests inject a stub rather than
 * monkey-patching `globalThis.fetch`, so a test can never leak a patched
 * global into another test file.
 */
export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
}

export interface HttpRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponse>;
