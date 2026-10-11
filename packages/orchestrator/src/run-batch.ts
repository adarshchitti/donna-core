import {
  type Source, type Snapshot, type Change, type Signal, type Coverage,
  type CollectorEnvelope, collectorEnvelopeSchema,
  SOURCE_LABELS, NOT_COVERED_CATEGORIES, SOURCE_LAG_DAYS,
  runId as runIdFor, snapshotId as snapshotIdFor, isoNow,
} from '@donna/contracts';
import { diffSnapshot } from '@donna/logic';
import type { SandboxRunner } from './sandbox.js';

/**
 * runBatch: the fold.
 *
 * This is the one place every other component meets, and the order is the whole
 * point. For ONE company:
 *
 *   1. run every due source, each in its own throwaway sandbox
 *   2. a successful fetch becomes an immutable snapshot; a failed one becomes a
 *      run record with status 'failed' and NOTHING ELSE -- never a snapshot
 *   3. diff each new snapshot against that pair's previous baseline
 *   4. when the LAST job has ended, ok or failed, hand the whole batch to the
 *      validator ONCE, then narrate only if the cluster fingerprint moved
 *
 * Step 4's "ok or failed" matters: waiting for every job to SUCCEED would mean
 * one broken portal silently suppresses the whole company's briefing. A failed
 * source is a coverage gap we report, not a reason to go quiet.
 */

export interface CollectorRunner {
  /** Executes one collector in a sandbox and returns its envelope. */
  collect(input: {
    company: { company_id: string; canonical_name: string; jurisdiction: string; registry_id: string; aliases: string[]; domains: string[] };
    source: Source;
    runId: string;
  }): Promise<{ envelope: CollectorEnvelope; sandbox_id: string | null }>;
}

export interface BatchStore {
  getCompany(companyId: string): Promise<Record<string, unknown> | null>;
  dealsForCompany(companyId: string): Promise<Array<Record<string, unknown>>>;
  latestOkSnapshot(companyId: string, source: Source): Promise<Snapshot | null>;
  insertSnapshot(input: Record<string, unknown>): Promise<{ snapshot_id: string; inserted: boolean }>;
  insertChanges(inputs: readonly Record<string, unknown>[]): Promise<number>;
  signalsForCompany(companyId: string): Promise<Signal[]>;
  upsertSignal(input: Record<string, unknown>): Promise<{ signal_id: string; outcome: string }>;
  putCluster(input: Record<string, unknown>): Promise<void>;
  putBriefing(input: Record<string, unknown>): Promise<void>;
  latestBriefing(companyId: string, mode: 'briefing' | 'profile'): Promise<{ [k: string]: unknown } | null>;
  setCoverage(companyId: string, coverage: Coverage): Promise<void>;
  startRun(input: Record<string, unknown>): Promise<{ _id: unknown; run_id: string }>;
  finishRun(ref: unknown, patch: Record<string, unknown>): Promise<void>;
  pushSchedule(companyId: string, source: Source, from?: Date): Promise<boolean>;
}

export interface RunBatchDeps {
  store: BatchStore;
  collectors: CollectorRunner;
  sandboxes: SandboxRunner;
  /** validator + narrator, injected so this file stays about orchestration. */
  validate: (input: ValidateCall) => ValidateOut;
  narrate: (input: NarrateCall) => Promise<NarrateOut>;
  bookId: string;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface ValidateCall {
  book_id: string;
  company: Record<string, unknown>;
  deals: Array<Record<string, unknown>>;
  changes: Change[];
  existing_signals: Signal[];
  baseline_snapshots?: Snapshot[];
}
export interface ValidateOut {
  signals: Signal[];
  cluster: Record<string, unknown> | null;
  mode?: 'briefing' | 'profile';
}
export interface NarrateCall {
  cluster: Record<string, unknown>;
  signals: Signal[];
  mode: 'briefing' | 'profile';
  book_id: string;
}
export interface NarrateOut { briefing: Record<string, unknown> }

export interface BatchOutcome {
  jobs: number;
  ok: number;
  failed: number;
  changes: number;
  signals: number;
  narrated: boolean;
  coverage: Coverage;
}

export async function runBatch(
  companyId: string,
  sources: Source[],
  batch: string,
  deps: RunBatchDeps,
): Promise<BatchOutcome> {
  const log = deps.log ?? (() => {});
  const company = await deps.store.getCompany(companyId);
  if (!company) throw new Error(`runBatch: company ${companyId} not in book ${deps.bookId}`);

  const canonical = {
    company_id: companyId,
    canonical_name: String(company.canonical_name ?? ''),
    jurisdiction: String(company.jurisdiction ?? ''),
    registry_id: String(company.registry_id ?? ''),
    aliases: Array.isArray(company.aliases) ? (company.aliases as string[]) : [],
    domains: Array.isArray(company.domains) ? (company.domains as string[]) : [],
  };

  const checked: Source[] = [];
  const failed: Source[] = [];
  const newSnapshots: Snapshot[] = [];
  const allChanges: Change[] = [];
  const baselineSnapshots: Snapshot[] = [];
  let firstRunPairs = 0;

  for (const source of sources) {
    const rid = runIdFor(companyId, source);
    const handle = await deps.store.startRun({
      run_id: rid, batch_id: batch, company_id: companyId, source,
    });

    let sandbox_id: string | null = null;
    try {
      const out = await deps.collectors.collect({ company: canonical, source, runId: rid });
      sandbox_id = out.sandbox_id;

      // Validate at the boundary. A malformed envelope is a failed run, not a
      // corrupt snapshot: the collector repo is built separately, so this is
      // where its output is checked rather than trusted.
      const envelope = collectorEnvelopeSchema.parse(out.envelope);

      if (!envelope.ok) {
        failed.push(source);
        await deps.store.finishRun(handle, {
          status: 'failed', error: envelope.error ?? 'collector reported not ok',
          credits_spent: envelope.credits_spent, ended_at: isoNow(), sandbox_id,
        });
        await deps.store.pushSchedule(companyId, source);
        continue;
      }

      // A successful fetch becomes an immutable snapshot.
      const sid = snapshotIdFor(companyId, source, envelope.fetched_at);
      await deps.store.insertSnapshot({
        snapshot_id: sid,
        company_id: companyId,
        source,
        fetched_at: envelope.fetched_at,
        run_id: rid,
        items: envelope.items,
        raw_excerpt: envelope.raw_excerpt,
        source_url: envelope.source_url,
        ok: true,
      });

      const baseline = await deps.store.latestOkSnapshot(companyId, source);
      const next = {
        ...envelope, snapshot_id: sid, book_id: deps.bookId, ok: true as const,
        content_hash: '',
      } as unknown as Snapshot;

      const diff = diffSnapshot(
        next,
        baseline && baseline.snapshot_id !== sid ? baseline : null,
        { bookId: deps.bookId, detectedAt: isoNow() },
      );

      if (diff.isFirstRun) {
        // First run is a baseline and never an alert. It is the profile's input.
        firstRunPairs += 1;
        baselineSnapshots.push(next);
      } else if (diff.changes.length > 0) {
        allChanges.push(...diff.changes);
      }

      newSnapshots.push(next);
      checked.push(source);
      await deps.store.finishRun(handle, {
        status: envelope.items.length === 0 ? 'empty' : 'ok',
        error: null, credits_spent: envelope.credits_spent,
        ended_at: isoNow(), cache_hit: false, sandbox_id,
      });
    } catch (error) {
      // A failed source is never silent. It lands in the run record and shows
      // on the company page as a gap in coverage.
      failed.push(source);
      await deps.store.finishRun(handle, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        ended_at: isoNow(), sandbox_id,
      });
      await deps.store.pushSchedule(companyId, source);
      log('job_failed', { company_id: companyId, source, error: String(error) });
    }
  }

  // Coverage is assembled from what actually happened, never from intent.
  const coverage = buildCoverage(checked, failed);
  await deps.store.setCoverage(companyId, coverage);

  if (allChanges.length > 0) await deps.store.insertChanges(allChanges);

  // The batch's last job has ended. Validate ONCE, for the whole company.
  const existing = await deps.store.signalsForCompany(companyId);
  const deals = await deps.store.dealsForCompany(companyId);
  const result = deps.validate({
    book_id: deps.bookId,
    company,
    deals,
    changes: allChanges,
    existing_signals: existing,
    baseline_snapshots: baselineSnapshots,
  });

  for (const signal of result.signals) {
    const { book_id: _b, ...rest } = signal as Signal & { book_id?: string };
    await deps.store.upsertSignal(rest as unknown as Record<string, unknown>);
  }

  let narrated = false;
  if (result.cluster) {
    const { book_id: _cb, ...clusterRest } = result.cluster as Record<string, unknown>;
    await deps.store.putCluster(clusterRest);

    const mode = result.mode ?? (firstRunPairs > 0 && allChanges.length === 0 ? 'profile' : 'briefing');
    const fingerprint = String((result.cluster as { fingerprint?: unknown }).fingerprint ?? '');
    const previous = await deps.store.latestBriefing(companyId, mode);
    const previousFingerprint = String(
      (previous as { cluster_fingerprint?: unknown } | null)?.cluster_fingerprint ?? '',
    );

    // Narrate only when the fingerprint moved, so the same cluster is not
    // re-narrated every day for a fortnight.
    if (fingerprint && fingerprint === previousFingerprint) {
      log('narration_skipped', { company_id: companyId, reason: 'fingerprint unchanged' });
    } else {
      const { briefing } = await deps.narrate({
        cluster: result.cluster, signals: result.signals, mode, book_id: deps.bookId,
      });
      const { book_id: _bb, ...briefingRest } = briefing;
      await deps.store.putBriefing({ ...briefingRest, cluster_fingerprint: fingerprint });
      narrated = true;
    }
  }

  return {
    jobs: sources.length, ok: checked.length, failed: failed.length,
    changes: allChanges.length, signals: result.signals.length, narrated, coverage,
  };
}

/**
 * checked/failed are source IDS; not_covered are human LABELS.
 *
 * not_covered carries the four things this system never observes, plus any
 * source we did not attempt at all -- so a source silently dropped from a
 * schedule shows up as uncovered rather than as implicitly fine. A declared
 * freshness lag is stated here too, because a docket that trails real filings
 * by days is a coverage fact, not a detail.
 */
export function buildCoverage(checked: Source[], failed: Source[]): Coverage {
  const attempted = new Set<Source>([...checked, ...failed]);
  const notAttempted = (Object.keys(SOURCE_LABELS) as Source[])
    .filter((s) => !attempted.has(s))
    .map((s) => SOURCE_LABELS[s]);

  const lags = [...attempted]
    .filter((s) => SOURCE_LAG_DAYS[s] !== undefined)
    .map((s) => `${SOURCE_LABELS[s]} lag up to ${SOURCE_LAG_DAYS[s]} days`);

  return {
    checked: [...checked],
    failed: [...failed],
    not_covered: [...NOT_COVERED_CATEGORIES, ...notAttempted, ...lags],
    as_of: isoNow(),
  };
}
