/**
 * Environment reading, in one place.
 *
 * Every variable this package looks at is listed here and nowhere else, so
 * "what do I need to set to go live?" has a single answer.
 *
 *   DONNA_FETCH_MODE            live | record | replay   (default: replay)
 *   BRIGHTDATA_API_KEY          Bearer token for api.brightdata.com
 *   BRIGHTDATA_UNLOCKER_ZONE    zone name used by unlocker()
 *   BRIGHTDATA_SERP_ZONE        zone name used by serp()
 *   DONNA_CASSETTE_DIR          cassette dir (default: <repo>/fixtures/cassettes)
 *   DONNA_FETCH_TIMEOUT_MS      per-request timeout (default: 30000)
 *   DONNA_CREDIT_CEILING        hard cumulative credit ceiling (default: none)
 *   DONNA_FETCH_CREDIT_CEILING  accepted alias for the above
 */

import { DEFAULT_FETCH_MODE, fetchModeSchema, type FetchMode } from './types.js';
import { FetchError } from './errors.js';

export type Env = Record<string, string | undefined>;

export const BRIGHTDATA_ENDPOINT = 'https://api.brightdata.com/request';
export const DEFAULT_TIMEOUT_MS = 30_000;
/** One Bright Data request = one credit. Cassette hits cost zero. */
export const CREDITS_PER_REQUEST = 1;

/**
 * Resolve the mode, defaulting to `replay` when unset.
 *
 * Fails closed by design: with no variable set, nothing in the system can
 * reach the network or spend a credit, so a bare `npm test` or a stray script
 * is harmless. Going live is an explicit act.
 */
export const resolveFetchMode = (env: Env = process.env): FetchMode => {
  const raw = env.DONNA_FETCH_MODE;
  if (raw === undefined || raw.trim() === '') return DEFAULT_FETCH_MODE;
  const parsed = fetchModeSchema.safeParse(raw.trim());
  if (!parsed.success) {
    throw new FetchError(
      `DONNA_FETCH_MODE=${JSON.stringify(raw)} is not one of live|record|replay. ` +
        `Unset it to get the safe default (${DEFAULT_FETCH_MODE}).`,
      { code: 'CONFIG', url: '<config>', mode: DEFAULT_FETCH_MODE },
    );
  }
  return parsed.data;
};

const positiveInt = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

export const readTimeoutMs = (env: Env = process.env): number =>
  positiveInt(env.DONNA_FETCH_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;

/**
 * The ceiling the orchestrator sets in `.env` is DONNA_CREDIT_CEILING; the
 * package-scoped name is accepted too so neither spelling silently does
 * nothing, which with a 300-credit budget would be an expensive typo.
 */
export const readCreditCeiling = (env: Env = process.env): number | undefined =>
  positiveInt(env.DONNA_CREDIT_CEILING) ?? positiveInt(env.DONNA_FETCH_CREDIT_CEILING);
