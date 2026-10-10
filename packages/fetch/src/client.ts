/**
 * The Bright Data client -- the only thing in Donna that performs an outbound
 * fetch of a target site.
 *
 * Both Bright Data products are the same endpoint and differ only by zone:
 *
 *   POST https://api.brightdata.com/request
 *   Authorization: Bearer <BRIGHTDATA_API_KEY>
 *   {"zone": "<zone>", "url": "<target>", "format": "raw"}
 *
 * Web Unlocker uses BRIGHTDATA_UNLOCKER_ZONE and takes a page URL; SERP uses
 * BRIGHTDATA_SERP_ZONE and takes a search-engine URL.
 */

import { fetchCacheKey, isoNow, utcDay } from '@donna/contracts';
import { FileCassetteStore } from './cassette.js';
import {
  BRIGHTDATA_ENDPOINT,
  CREDITS_PER_REQUEST,
  readCreditCeiling,
  readTimeoutMs,
  resolveFetchMode,
  type Env,
} from './config.js';
import { CassetteMissError, CreditCeilingError, FetchError } from './errors.js';
import { parseSerpResults, serpUrl } from './serp.js';
import type {
  BrightDataClient,
  CassetteStore,
  FetchLike,
  FetchMode,
  FetchResult,
  SerpOptions,
  SerpPage,
} from './types.js';

export interface BrightDataClientOptions {
  /** Defaults to DONNA_FETCH_MODE, which defaults to `replay`. */
  mode?: FetchMode;
  /** Defaults to `process.env`; injectable so tests never mutate the real env. */
  env?: Env;
  apiKey?: string;
  unlockerZone?: string;
  serpZone?: string;
  /** Defaults to a FileCassetteStore over `cassetteDir`. */
  store?: CassetteStore;
  cassetteDir?: string;
  /** Injected HTTP. Defaults to global `fetch`; tests pass a stub. */
  fetchImpl?: FetchLike;
  /** Hard cumulative ceiling. Live calls throw CreditCeilingError once reached. */
  creditCeiling?: number;
  timeoutMs?: number;
  /** Retries AFTER the first attempt, for transient failures only. Default 2. */
  maxRetries?: number;
  /** Base backoff; attempt n waits backoffMs * 2^(n-1). Default 250ms. */
  backoffMs?: number;
  /**
   * Write successful live responses back to the store. Defaults to true in
   * `record` mode only. Set it in `live` mode with a Mongo-backed store to get
   * the production `fetch_cache` write-through behaviour.
   */
  writeThrough?: boolean;
  /** Clock, so tests can pin the UTC day the cache key is built from. */
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** 429 and 5xx are worth another try; any other 4xx is our fault, not theirs. */
const isTransientStatus = (status: number): boolean => status === 429 || status >= 500;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

const defaultFetch: FetchLike = (url, init) => {
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  if (f === undefined) {
    throw new Error('No global fetch available; pass fetchImpl to createBrightDataClient.');
  }
  return f(url, init);
};

export class BrightDataFetcher implements BrightDataClient {
  readonly mode: FetchMode;
  readonly store: CassetteStore;
  readonly creditCeiling: number | undefined;

  private readonly env: Env;
  private readonly apiKey: string | undefined;
  private readonly unlockerZone: string | undefined;
  private readonly serpZone: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly writeThrough: boolean;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private spent = 0;

  constructor(opts: BrightDataClientOptions = {}) {
    this.env = opts.env ?? process.env;
    this.mode = opts.mode ?? resolveFetchMode(this.env);
    this.apiKey = opts.apiKey ?? this.env.BRIGHTDATA_API_KEY;
    this.unlockerZone = opts.unlockerZone ?? this.env.BRIGHTDATA_UNLOCKER_ZONE;
    this.serpZone = opts.serpZone ?? this.env.BRIGHTDATA_SERP_ZONE;
    this.store = opts.store ?? new FileCassetteStore(opts.cassetteDir ?? this.env.DONNA_CASSETTE_DIR);
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.creditCeiling = opts.creditCeiling ?? readCreditCeiling(this.env);
    this.timeoutMs = opts.timeoutMs ?? readTimeoutMs(this.env);
    this.maxRetries = opts.maxRetries ?? 2;
    this.backoffMs = opts.backoffMs ?? 250;
    this.writeThrough = opts.writeThrough ?? this.mode === 'record';
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? defaultSleep;
  }

  creditsSpent(): number {
    return this.spent;
  }

  /** For the orchestrator's credit display: spend against the ceiling. */
  credits(): { spent: number; ceiling: number | undefined; remaining: number | undefined } {
    return {
      spent: this.spent,
      ceiling: this.creditCeiling,
      remaining: this.creditCeiling === undefined ? undefined : this.creditCeiling - this.spent,
    };
  }

  async unlocker(url: string): Promise<FetchResult> {
    return this.through(url, () => this.requireZone(this.unlockerZone, 'BRIGHTDATA_UNLOCKER_ZONE', url));
  }

  async serp(query: string, opts: SerpOptions = {}): Promise<FetchResult> {
    const url = serpUrl(query, opts);
    return this.through(url, () => this.requireZone(this.serpZone, 'BRIGHTDATA_SERP_ZONE', url));
  }

  /**
   * SERP plus parsed organic results. Collectors use this to decide which
   * result URLs are new and therefore worth an unlocker credit.
   */
  async serpResults(query: string, opts: SerpOptions = {}): Promise<SerpPage> {
    const result = await this.serp(query, opts);
    return { ...result, results: parseSerpResults(result.body) };
  }

  // -------------------------------------------------------------------------
  // The one path every fetch takes.
  // -------------------------------------------------------------------------

  /**
   * Cache first, always. The cassette key IS the fetch cache key -- URL plus
   * UTC day -- so a same-day re-run of the same URL costs zero credits in
   * every mode, and the file store here and a Mongo `fetch_cache` later are
   * two backends of one interface rather than two mechanisms.
   */
  private async through(url: string, zoneFor: () => string): Promise<FetchResult> {
    const day = utcDay(this.now());
    const key = fetchCacheKey(url, day);

    const hit = await this.store.get(key);
    if (hit !== undefined) {
      return {
        body: hit.body,
        url,
        // The recorded fetch time, not now: evidence must carry the instant the
        // bytes were actually obtained.
        fetched_at: hit.fetched_at,
        credits_spent: 0,
        cache_hit: true,
      };
    }

    if (this.mode === 'replay') {
      // Never fall through to the network. A test that reaches here has a
      // missing fixture, not a flaky network, and the message says which.
      throw new CassetteMissError({
        url,
        key,
        expectedPath: this.store.locate(key),
        mode: this.mode,
      });
    }

    const zone = zoneFor();
    this.assertCreditsAvailable(url);

    const { status, body } = await this.request(url, zone);
    // Counted once per successful request; retried attempts that failed are
    // not billed, matching how Bright Data charges.
    this.spent += CREDITS_PER_REQUEST;
    const fetched_at = isoNow(this.now());

    if (this.writeThrough) {
      await this.store.put({ key, url, day, zone, status, fetched_at, body });
    }

    return { body, url, fetched_at, credits_spent: CREDITS_PER_REQUEST, cache_hit: false };
  }

  private assertCreditsAvailable(url: string): void {
    if (this.creditCeiling !== undefined && this.spent >= this.creditCeiling) {
      throw new CreditCeilingError({
        url,
        mode: this.mode,
        spent: this.spent,
        ceiling: this.creditCeiling,
      });
    }
  }

  private requireZone(zone: string | undefined, varName: string, url: string): string {
    if (zone === undefined || zone === '') {
      throw new FetchError(
        `${varName} is not set, so a ${this.mode}-mode fetch of ${url} cannot name a ` +
          `Bright Data zone. Use DONNA_FETCH_MODE=replay to run offline.`,
        { code: 'CONFIG', url, mode: this.mode },
      );
    }
    return zone;
  }

  /**
   * One Bright Data request, with timeout and bounded retry. Never lets a raw
   * fetch rejection escape: everything is wrapped with the URL and the mode,
   * which is what a collector writes into `envelope.error`.
   */
  private async request(url: string, zone: string): Promise<{ status: number; body: string }> {
    if (this.apiKey === undefined || this.apiKey === '') {
      throw new FetchError(
        `BRIGHTDATA_API_KEY is not set, so a ${this.mode}-mode fetch of ${url} cannot ` +
          `authenticate. Use DONNA_FETCH_MODE=replay to run offline.`,
        { code: 'CONFIG', url, mode: this.mode },
      );
    }

    const payload = JSON.stringify({ zone, url, format: 'raw' });
    let lastDetail = 'no attempt made';

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) await this.sleep(this.backoffMs * 2 ** (attempt - 1));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(BRIGHTDATA_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: payload,
          signal: controller.signal,
        });
        const text = await res.text();

        if (res.ok) return { status: res.status, body: text };

        lastDetail = `HTTP ${res.status}: ${text.slice(0, 200)}`;
        // A 4xx that is not 429 is a bad request or a bad key -- retrying just
        // burns time and, on some plans, credits.
        if (!isTransientStatus(res.status) || attempt === this.maxRetries) {
          throw new FetchError(
            `Bright Data ${this.mode} fetch of ${url} failed after ${attempt + 1} ` +
              `attempt(s) (zone ${zone}): ${lastDetail}`,
            { code: 'HTTP', url, mode: this.mode },
          );
        }
      } catch (err) {
        if (err instanceof FetchError) throw err;
        const aborted = controller.signal.aborted;
        lastDetail = aborted
          ? `timed out after ${this.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
        if (attempt === this.maxRetries) {
          throw new FetchError(
            `Bright Data ${this.mode} fetch of ${url} failed after ${attempt + 1} ` +
              `attempt(s) (zone ${zone}): ${lastDetail}`,
            { code: aborted ? 'TIMEOUT' : 'NETWORK', url, mode: this.mode, cause: err },
          );
        }
      } finally {
        clearTimeout(timer);
      }
    }

    // Unreachable: the final attempt either returns or throws.
    throw new FetchError(
      `Bright Data ${this.mode} fetch of ${url} exhausted retries: ${lastDetail}`,
      { code: 'NETWORK', url, mode: this.mode },
    );
  }
}

export const createBrightDataClient = (opts: BrightDataClientOptions = {}): BrightDataFetcher =>
  new BrightDataFetcher(opts);
