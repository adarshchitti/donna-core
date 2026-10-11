/**
 * Environment reading, in one place.
 *
 * Every variable this package looks at is listed here and nowhere else, so
 * "what do I need to set to go live?" has a single answer.
 *
 *   DONNA_FETCH_MODE            live | record | replay   (default: replay)
 *   BRIGHTDATA_API_KEY          Bearer token for api.brightdata.com
 *   BRIGHTDATA_API_KEYS         ordered rotation list; see readApiKeys()
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

/**
 * The ordered list of API keys the client may use.
 *
 * We hold several keys, each with its own slice of the budget, and the
 * rotation order matters -- so it lives in BRIGHTDATA_API_KEYS (comma- or
 * whitespace-separated) rather than being inferred. BRIGHTDATA_API_KEY is the
 * single-key spelling; it goes first unless the list already names it, so
 * setting either variable does something and setting both is not a conflict.
 */
export const readApiKeys = (env: Env = process.env): string[] => {
  const list = (env.BRIGHTDATA_API_KEYS ?? '')
    .split(/[,\s]+/)
    .map((k) => k.trim())
    .filter((k) => k !== '');
  const single = (env.BRIGHTDATA_API_KEY ?? '').trim();
  if (single !== '' && !list.includes(single)) list.unshift(single);
  return list;
};

/** Every variable a live or record fetch needs, in the order a human fixes them. */
export const LIVE_ENV_VARS = [
  'BRIGHTDATA_API_KEY',
  'BRIGHTDATA_UNLOCKER_ZONE',
  'BRIGHTDATA_SERP_ZONE',
] as const;

/**
 * Which of those are missing. Returned rather than thrown so a caller can
 * report all of them at once: discovering a second missing variable after a
 * run has already spent credits on the sources that happened to come first is
 * how an afternoon disappears.
 */
export const missingLiveEnv = (env: Env = process.env): string[] => {
  const missing: string[] = [];
  if (readApiKeys(env).length === 0) missing.push('BRIGHTDATA_API_KEY');
  if ((env.BRIGHTDATA_UNLOCKER_ZONE ?? '').trim() === '') missing.push('BRIGHTDATA_UNLOCKER_ZONE');
  if ((env.BRIGHTDATA_SERP_ZONE ?? '').trim() === '') missing.push('BRIGHTDATA_SERP_ZONE');
  return missing;
};

/**
 * Fail before the first fetch, not per-source during the run.
 *
 * The zone variables are the ones that bite: a missing BRIGHTDATA_UNLOCKER_ZONE
 * lets a live pass start, serve its SERP-only sources, and fail every source
 * that unlocks a page -- six of eight collectors -- with a config error that
 * reads like a Bright Data outage.
 */
export const assertLiveEnv = (env: Env = process.env, mode: FetchMode = 'live'): void => {
  const missing = missingLiveEnv(env);
  if (missing.length === 0) return;
  throw new FetchError(
    `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set, so a ` +
      `${mode}-mode run cannot reach Bright Data. Set them in .env.local ` +
      `(zones are named in the Bright Data console, e.g. web_unlocker1 / serp_api1), ` +
      `or use DONNA_FETCH_MODE=replay to run offline.`,
    { code: 'CONFIG', url: '<config>', mode },
  );
};
