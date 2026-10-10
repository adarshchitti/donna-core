/**
 * Fetch-layer errors.
 *
 * Why a dedicated hierarchy: a collector's job is to turn a failure into
 * `{ok: false, error}` on its envelope, not to crash the run. So nothing in
 * this package ever lets a raw `fetch` rejection escape -- every failure is
 * wrapped in a `FetchError` carrying the URL and the mode it happened in,
 * which is exactly what a collector needs to write into `envelope.error`.
 *
 * `code` exists so a caller can branch without `instanceof` across module
 * boundaries (bundlers can duplicate class identity); `instanceof` still works
 * and is the documented way to catch the ceiling.
 */

import type { FetchMode } from './types.js';

export type FetchErrorCode =
  | 'CASSETTE_MISS'
  | 'CREDIT_CEILING'
  | 'HTTP'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'CONFIG'
  /** A 200 whose body says the zone cannot serve this target. See client.ts. */
  | 'UNSUPPORTED_TARGET';

export class FetchError extends Error {
  readonly name: string = 'FetchError';
  readonly code: FetchErrorCode;
  readonly url: string;
  readonly mode: FetchMode;

  constructor(
    message: string,
    opts: { code: FetchErrorCode; url: string; mode: FetchMode; cause?: unknown },
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.code = opts.code;
    this.url = opts.url;
    this.mode = opts.mode;
  }
}

/**
 * Thrown in `replay` mode when no cassette exists for URL + UTC day.
 *
 * The message names the URL, the key and the exact path a cassette is expected
 * at, because the fix is always "record this one URL" and a hash-named file is
 * otherwise unguessable. Replay never falls through to the network, so this
 * error is the only possible outcome of a miss -- tests stay deterministic.
 */
export class CassetteMissError extends FetchError {
  override readonly name = 'CassetteMissError';
  readonly key: string;
  readonly expectedPath: string;

  constructor(opts: { url: string; key: string; expectedPath: string; mode: FetchMode }) {
    super(
      `Cassette miss in ${opts.mode} mode for ${opts.url}\n` +
        `  cache key:     ${opts.key}\n` +
        `  expected file: ${opts.expectedPath}\n` +
        `  Record it with DONNA_FETCH_MODE=record (costs credits), ` +
        `or check the UTC day -- cassettes are keyed by URL + UTC day.`,
      { code: 'CASSETTE_MISS', url: opts.url, mode: opts.mode },
    );
    this.key = opts.key;
    this.expectedPath = opts.expectedPath;
  }
}

/**
 * Thrown instead of spending a credit once cumulative spend has reached the
 * configured ceiling. We have a hard, small credit budget for the whole event,
 * so a runaway loop must fail loudly rather than quietly burn it. Replay-mode
 * calls never reach this check: they cost nothing.
 */
export class CreditCeilingError extends FetchError {
  override readonly name = 'CreditCeilingError';
  readonly spent: number;
  readonly ceiling: number;

  constructor(opts: { url: string; mode: FetchMode; spent: number; ceiling: number }) {
    super(
      `Credit ceiling reached: ${opts.spent}/${opts.ceiling} credits spent, ` +
        `refusing a live fetch of ${opts.url} in ${opts.mode} mode.`,
      { code: 'CREDIT_CEILING', url: opts.url, mode: opts.mode },
    );
    this.spent = opts.spent;
    this.ceiling = opts.ceiling;
  }
}

/** True for any error this package raises. */
export const isFetchError = (e: unknown): e is FetchError => e instanceof FetchError;
