/**
 * A Fetcher decorator that records every call: target, bytes, credits and --
 * when the fetch layer threw one -- the FetchError code. It exists because a
 * collector envelope carries only totals, and the credit report needs to show
 * WHICH calls cost what and which were refused.
 *
 * `dataset()` is forwarded only when the inner fetcher implements it, so the
 * jobs collector's feature-detect (`typeof fetcher.dataset === 'function'`)
 * keeps working exactly as it does against the raw fetcher.
 */
import { isFetchError } from '@donna/fetch';
import type { Fetcher, FetchResult } from '../../../donna-collectors/src/contract.js';

export interface FetchCall {
  kind: 'unlocker' | 'serp' | 'dataset';
  target: string;
  ok: boolean;
  bytes: number;
  credits: number;
  cache_hit: boolean;
  error?: string;
  /** FetchError.code when the fetch layer classified it (POLICY_REFUSED, CONFIG, ...). */
  code?: string;
}

type DatasetFn = (
  datasetId: string,
  filter: { name: string; operator: string; value: string },
  recordsLimit?: number,
) => Promise<FetchResult>;

export class MeteredFetcher implements Fetcher {
  readonly calls: FetchCall[] = [];

  constructor(private readonly inner: Fetcher) {
    const dataset = (inner as { dataset?: DatasetFn }).dataset;
    if (typeof dataset === 'function') {
      (this as unknown as { dataset: DatasetFn }).dataset = (id, filter, limit) =>
        this.track('dataset', `${id}|${filter.value}`, () => dataset.call(inner, id, filter, limit));
    }
  }

  unlocker(url: string): Promise<FetchResult> {
    return this.track('unlocker', url, () => this.inner.unlocker(url));
  }

  serp(query: string, opts: { gl?: string; hl?: string } = {}): Promise<FetchResult> {
    return this.track('serp', query, () => this.inner.serp(query, opts));
  }

  private async track(
    kind: FetchCall['kind'],
    target: string,
    fn: () => Promise<FetchResult>,
  ): Promise<FetchResult> {
    try {
      const res = await fn();
      this.calls.push({
        kind, target, ok: true, bytes: res.body.length,
        credits: res.credits_spent, cache_hit: res.cache_hit,
      });
      return res;
    } catch (err) {
      this.calls.push({
        kind, target, ok: false, bytes: 0, credits: 0, cache_hit: false,
        error: err instanceof Error ? err.message : String(err),
        ...(isFetchError(err) ? { code: err.code } : {}),
      });
      throw err;
    }
  }

  /** Cumulative spend on the inner fetcher, when it tracks one (BrightDataFetcher). */
  creditsSpent(): number | undefined {
    const tracker = this.inner as { creditsSpent?: () => number };
    return typeof tracker.creditsSpent === 'function' ? tracker.creditsSpent() : undefined;
  }

  /** Calls recorded since `mark`, for per-source attribution on a shared fetcher. */
  mark(): number {
    return this.calls.length;
  }

  since(mark: number): FetchCall[] {
    return this.calls.slice(mark);
  }

  static totals(calls: readonly FetchCall[]): { fetches: number; credits: number; bytes: number; failed: number } {
    return calls.reduce(
      (acc, c) => ({
        fetches: acc.fetches + 1,
        credits: acc.credits + c.credits,
        bytes: acc.bytes + c.bytes,
        failed: acc.failed + (c.ok ? 0 : 1),
      }),
      { fetches: 0, credits: 0, bytes: 0, failed: 0 },
    );
  }
}
