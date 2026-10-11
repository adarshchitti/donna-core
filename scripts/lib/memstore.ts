/**
 * An in-memory BatchStore: the dry-run half of onboard-book.
 *
 * It implements the same seam DonnaStore does, through the same zod schemas,
 * so a dry run exercises the REAL runBatch -> differ -> validator -> narrator
 * path end to end while writing nothing and reading nothing outside this
 * process. Where the real store's behaviour matters to the pipeline (snapshot
 * idempotency, the 14-day signal merge window, coverage via $set) it is
 * mirrored; where it doesn't (indexes, concurrency) it is omitted.
 */
import {
  briefingSchema, changeSchema, clusterSchema, collectorRunSchema, coverageSchema,
  signalSchema, snapshotSchema, isoNow, signalId as makeSignalId,
  type Change, type CollectorRun, type Coverage, type Signal, type Snapshot, type Source,
} from '@donna/contracts';
import { randomUUID } from 'node:crypto';
import { contentHash } from '@donna/store';
import { daysApart } from '@donna/logic';
import type { BatchStore } from '../../packages/orchestrator/src/run-batch.js';

const SIGNAL_WINDOW_DAYS = 14;

interface StoredRun extends CollectorRun { _id: number }

export class InMemoryBatchStore implements BatchStore {
  readonly companies = new Map<string, Record<string, unknown>>();
  readonly runs: StoredRun[] = [];
  readonly snapshots: Snapshot[] = [];
  readonly changes: Change[] = [];
  readonly signals = new Map<string, Signal>();
  readonly clusters = new Map<string, Record<string, unknown>>();
  readonly briefings = new Map<string, Record<string, unknown>>();
  readonly schedules = new Map<string, {
    cadence: 'daily' | 'weekly'; next_run_at: string; last_run_at: string | null;
    enabled?: boolean; expires_at?: string | null;
  }>();
  private deals: Record<string, unknown>[] = [];
  private nextId = 1;

  constructor(private readonly bookId: string) {}

  seedCompany(doc: Record<string, unknown>): void {
    this.companies.set(String(doc.company_id), { ...doc, book_id: this.bookId });
  }

  async getCompany(companyId: string): Promise<Record<string, unknown> | null> {
    return this.companies.get(companyId) ?? null;
  }

  async dealsForCompany(companyId: string): Promise<Record<string, unknown>[]> {
    return this.deals.filter((d) => d['company_id'] === companyId);
  }

  async latestOkSnapshot(companyId: string, source: Source): Promise<Snapshot | null> {
    const list = this.snapshots
      .filter((s) => s.company_id === companyId && s.source === source && s.ok)
      .sort((a, b) => (a.fetched_at < b.fetched_at ? 1 : -1));
    return list[0] ?? null;
  }

  async insertSnapshot(input: Record<string, unknown>): Promise<{ snapshot_id: string; inserted: boolean }> {
    const doc = snapshotSchema.parse({
      ...input,
      book_id: this.bookId,
      content_hash: input['content_hash'] ?? contentHash(input['items']),
    });
    if (this.snapshots.some((s) => s.snapshot_id === doc.snapshot_id)) {
      return { snapshot_id: doc.snapshot_id, inserted: false };
    }
    this.snapshots.push(doc);
    return { snapshot_id: doc.snapshot_id, inserted: true };
  }

  async insertChanges(inputs: readonly Record<string, unknown>[]): Promise<number> {
    for (const c of inputs) {
      this.changes.push(changeSchema.parse({ ...c, book_id: this.bookId }));
    }
    return inputs.length;
  }

  async signalsForCompany(companyId: string): Promise<Signal[]> {
    return [...this.signals.values()]
      .filter((s) => s.company_id === companyId && s.book_id === this.bookId)
      .sort((a, b) => b.tier - a.tier || (a.first_seen < b.first_seen ? 1 : -1));
  }

  async upsertSignal(input: Record<string, unknown>): Promise<{ signal_id: string; outcome: string }> {
    const signal = signalSchema.parse({
      ...input,
      book_id: this.bookId,
      signal_id: input['signal_id'] ?? makeSignalId(
        String(input['company_id']), String(input['type']), String(input['first_seen']),
      ),
    });

    const target = [...this.signals.values()].find(
      (s) =>
        s.company_id === signal.company_id
        && s.type === signal.type
        && daysApart(s.first_seen, signal.first_seen) <= SIGNAL_WINDOW_DAYS,
    );
    if (!target) {
      this.signals.set(signal.signal_id, signal);
      return { signal_id: signal.signal_id, outcome: 'created' };
    }

    const seen = new Set(target.evidence.map((e) => `${e.snapshot_id}|${e.url}|${e.excerpt}`));
    const evidence = [...target.evidence];
    for (const e of signal.evidence) {
      const key = `${e.snapshot_id}|${e.url}|${e.excerpt}`;
      if (!seen.has(key)) evidence.push(e);
    }
    const rank = { low: 0, medium: 1, high: 2 } as const;
    this.signals.set(target.signal_id, {
      ...target,
      evidence,
      tier: Math.max(target.tier, signal.tier) as Signal['tier'],
      status: signal.status,
      title: signal.title,
      summary_fact: signal.summary_fact,
      confidence: rank[target.confidence] >= rank[signal.confidence] ? target.confidence : signal.confidence,
      touches_terms: [...new Set([...target.touches_terms, ...signal.touches_terms])],
    });
    return { signal_id: target.signal_id, outcome: 'merged' };
  }

  async putCluster(input: Record<string, unknown>): Promise<void> {
    const doc = clusterSchema.parse({ ...input, book_id: this.bookId });
    this.clusters.set(doc.cluster_id, doc);
  }

  async putBriefing(input: Record<string, unknown>): Promise<void> {
    const doc = briefingSchema.parse({ ...input, book_id: this.bookId });
    // runBatch attaches cluster_fingerprint outside the contract; keep it so
    // the narration-skip check behaves like production.
    this.briefings.set(doc.briefing_id, { ...doc, cluster_fingerprint: input['cluster_fingerprint'] });
  }

  async latestBriefing(
    companyId: string,
    mode: 'briefing' | 'profile',
  ): Promise<Record<string, unknown> | null> {
    const list = [...this.briefings.values()]
      .filter((b) => b['company_id'] === companyId && b['mode'] === mode)
      .sort((a, b) => (String(a['generated_at']) < String(b['generated_at']) ? 1 : -1));
    return list[0] ?? null;
  }

  async setCoverage(companyId: string, coverage: Coverage): Promise<void> {
    const doc = coverageSchema.parse({ ...coverage, as_of: coverage.as_of ?? isoNow() });
    const company = this.companies.get(companyId);
    if (!company) throw new Error(`setCoverage: no company ${companyId}`);
    company['coverage'] = doc;
    company['last_checked_at'] = doc.as_of;
  }

  async startRun(input: Record<string, unknown>): Promise<{ _id: unknown; run_id: string }> {
    const doc = collectorRunSchema.parse({
      run_id: input['run_id'],
      batch_id: input['batch_id'],
      company_id: input['company_id'],
      source: input['source'],
      started_at: input['started_at'] ?? isoNow(),
      ended_at: null,
      status: 'started',
      error: null,
      credits_spent: 0,
      sandbox_id: input['sandbox_id'] ?? null,
      cache_hit: input['cache_hit'] ?? false,
      book_id: this.bookId,
    });
    const _id = this.nextId++;
    this.runs.push({ _id, ...doc });
    return { _id, run_id: doc.run_id };
  }

  async finishRun(ref: unknown, patch: Record<string, unknown>): Promise<void> {
    const id = (ref as { _id: number })._id;
    const run = this.runs.find((r) => r._id === id);
    if (!run) throw new Error(`finishRun: no run for ${JSON.stringify(ref)}`);
    Object.assign(run, {
      status: patch['status'],
      error: patch['error'] ?? null,
      credits_spent: patch['credits_spent'] ?? run.credits_spent,
      ended_at: patch['ended_at'] ?? isoNow(),
      cache_hit: patch['cache_hit'] ?? run.cache_hit,
      sandbox_id: patch['sandbox_id'] ?? run.sandbox_id,
    });
    collectorRunSchema.parse(run);
  }

  async pushSchedule(companyId: string, source: Source, from: Date = new Date()): Promise<boolean> {
    const key = `${companyId}|${source}`;
    const s = this.schedules.get(key);
    if (!s) return false;
    const hours = s.cadence === 'weekly' ? 24 * 7 : 24;
    s.next_run_at = new Date(from.getTime() + hours * 3_600_000).toISOString();
    s.last_run_at = from.toISOString();
    return true;
  }

  /** Beyond the BatchStore seam: summaries need the run rows the batch produced. */
  async runsForBatch(batchId: string): Promise<StoredRun[]> {
    return this.runs.filter((r) => r.batch_id === batchId);
  }

  snapshotsForCompany(companyId: string): Snapshot[] {
    return this.snapshots.filter((s) => s.company_id === companyId);
  }
}

/**
 * The in-memory store for scripts/lookup.ts in replay: the batch seam plus the
 * few writes a lookup makes (company upsert by registry id, resolution,
 * schedules) and the credit sums the lookup ceiling reads.
 */
export class InMemoryLookupStore extends InMemoryBatchStore {
  async upsertCompany(input: Record<string, unknown>): Promise<{ company_id: string; outcome: string }> {
    const registryId = String(input['registry_id'] ?? '').trim();
    const existing = [...this.companies.values()].find(
      (c) => registryId !== '' && c['registry_id'] === registryId && c['jurisdiction'] === input['jurisdiction'],
    );
    if (existing) return { company_id: String(existing['company_id']), outcome: 'unchanged' };
    const company_id = String(input['company_id'] ?? randomUUID());
    this.seedCompany({
      officers: [], related_entities: [], aliases: [], domains: [],
      ...input,
      company_id,
      registry_id: registryId,
      registry_key: registryId ? registryId.toUpperCase() : `MANUAL:${company_id}`,
    });
    return { company_id, outcome: 'inserted' };
  }

  async setResolution(companyId: string, input: Record<string, unknown>): Promise<void> {
    const company = this.companies.get(companyId);
    if (!company) throw new Error(`setResolution: no company ${companyId}`);
    company['resolution'] = { resolved_by: 'auto_resolver', candidates_seen: [], ...input, resolved_at: isoNow() };
  }

  async upsertSchedule(input: {
    company_id: string; source: Source; cadence: 'daily' | 'weekly';
    next_run_at: string; enabled?: boolean; expires_at?: string | null;
  }): Promise<void> {
    this.schedules.set(`${input.company_id}|${input.source}`, {
      cadence: input.cadence, next_run_at: input.next_run_at, last_run_at: null,
      enabled: input.enabled ?? true, expires_at: input.expires_at ?? null,
    });
  }

  schedulesFor(companyId: string): Array<{ expires_at?: string | null }> {
    return [...this.schedules.entries()].filter(([k]) => k.startsWith(`${companyId}|`)).map(([, v]) => v);
  }

  async creditsSpentTotal(): Promise<number> {
    return this.runs.reduce((sum, r) => sum + (r.credits_spent ?? 0), 0);
  }

  async creditsSpentOnLookups(): Promise<number> {
    const prospects = new Set(
      [...this.companies.values()]
        .filter((c) => c['lookup'] !== undefined && c['monitoring_since'] === undefined)
        .map((c) => String(c['company_id'])),
    );
    return this.runs.filter((r) => prospects.has(r.company_id)).reduce((sum, r) => sum + (r.credits_spent ?? 0), 0);
  }
}
