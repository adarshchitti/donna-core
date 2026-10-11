import {
  SOURCES, batchId, utcDay, type Coverage, type Signal, type Source,
} from '@donna/contracts';
import { PROFILE_SECTION_TITLES } from '@donna/logic';
import { CADENCE } from './loop.js';
import { outcomeFor, type Judge } from './resolution.js';
import type { CandidateSource } from './resolve-pending.js';
import { runBatch, type BatchStore, type RunBatchDeps } from './run-batch.js';

/**
 * runLookup: a counterparty profile BEFORE the signature, while there is still
 * a choice.
 *
 * Until now the pipeline could only be entered through a deal, which arrives
 * one signature too late. A lookup is the same pipeline entered earlier: the
 * same resolution rules, one runBatch over every source, and the first-run
 * profile the narrator already writes -- whose fourth section is "What to ask
 * before signing".
 *
 * It is a `companies` document with `lookup` set and NO `monitoring_since`.
 * There is no lookups collection. And it is ONE SHOT: no schedules unless the
 * caller asks for a bounded watch, because thirty companies glanced at once
 * would otherwise cost credits every day forever, against a 300-credit budget.
 */

/**
 * What one lookup is expected to cost, checked against the lookup ceiling
 * BEFORE anything is fetched. A full pass over the eight sources measured 13
 * credits (scripts/measure-credits.ts) -- more than eight, because some
 * collectors need a SERP and a page. Resolution adds one registry search and
 * one SERP. Same-day repeats are cheaper through the fetch cache, so this
 * errs high, which is the side a ceiling should err on.
 */
export const LOOKUP_PASS_CREDITS = 13;
export const RESOLUTION_CREDITS = 2;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class LookupInputError extends Error {}

export interface LookupInput {
  name: string;
  country: string;
  requestedBy: string;
  /** Date-only. Absent or null: one shot. A day: watch every source until it ends. */
  watchUntil?: string | null;
  /**
   * Set by the loop poll: the intent document the surface wrote. The CLI
   * leaves it unset and the company is upserted by registry id.
   */
  companyId?: string;
}

type ScheduleWrite = {
  company_id: string; source: Source; cadence: 'daily' | 'weekly';
  next_run_at: string; enabled?: boolean; expires_at?: string | null;
};

/** The company write a lookup makes -- a subset of the store's CompanyUpsertInput. */
export interface LookupCompanyWrite {
  company_id?: string;
  canonical_name: string;
  jurisdiction: string;
  registry_id?: string;
  aliases?: string[];
  domains?: string[];
  officers?: Record<string, unknown>[];
  related_entities?: Record<string, unknown>[];
  resolution?: {
    confidence: number | null; reason: string; resolved_by: string | null;
    candidates_seen?: Record<string, unknown>[]; resolved_at?: string;
  };
  lookup?: { requested_at: string; requested_by: string; watch_until: string | null };
}

export interface LookupStore extends BatchStore {
  upsertCompany(input: LookupCompanyWrite): Promise<{ company_id: string; outcome: string }>;
  setResolution(companyId: string, input: {
    confidence: number | null; reason: string; candidates_seen?: Record<string, unknown>[];
  }): Promise<void>;
  upsertSchedule(input: ScheduleWrite): Promise<void>;
  runsForBatch(batch: string): Promise<ReadonlyArray<{
    source: string; status: string; credits_spent: number; error?: string | null;
  }>>;
  creditsSpentOnLookups(): Promise<number>;
  creditsSpentTotal(): Promise<number>;
}

export interface LookupDeps {
  store: LookupStore;
  candidates: CandidateSource;
  judge: Judge;
  /** Everything runBatch needs except the store, which is `store` above. */
  batch: Omit<RunBatchDeps, 'store'>;
  /** Credits prospects may spend in total. Separate from DONNA_CREDIT_CEILING. */
  lookupCeiling: number;
  /** DONNA_CREDIT_CEILING. A lookup must fit under both. */
  creditCeiling?: number;
  now?: () => Date;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface LookupRun {
  source: string;
  status: string;
  credits_spent: number;
  error: string | null;
}

export interface LookupOutcome {
  status:
    | 'profiled'           // collected once; the profile is written
    | 'needs_review'       // below threshold: parked, nothing fetched
    | 'could_not_look'     // the registry could not be searched: parked, nothing fetched
    | 'over_ceiling'       // refused before any fetch
    | 'already_collected'  // a prospect we already profiled; not collected again
    | 'already_monitored'; // a company under a signed deal; a lookup adds nothing
  company_id: string | null;
  resolution: {
    status: 'resolved' | 'needs_review' | 'could_not_look' | 'preresolved';
    confidence: number | null;
    reason: string;
    candidates_seen: Record<string, unknown>[];
  } | null;
  runs: LookupRun[];
  briefing_id: string | null;
  coverage: Coverage | null;
  credits_spent: number;
  /** How many schedules this call wrote. Zero is the one-shot rule holding. */
  schedules_written: number;
  /** Ways the first run was NOT a baseline. Empty is the only correct value. */
  baseline_violations: string[];
  reason?: string;
}

const emptyOutcome = (status: LookupOutcome['status'], over: Partial<LookupOutcome> = {}): LookupOutcome => ({
  status, company_id: null, resolution: null, runs: [], briefing_id: null, coverage: null,
  credits_spent: 0, schedules_written: 0, baseline_violations: [], ...over,
});

export async function runLookup(input: LookupInput, deps: LookupDeps): Promise<LookupOutcome> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const { store } = deps;
  const watchUntil = input.watchUntil ?? null;
  if (watchUntil !== null) assertWatchUntil(watchUntil, utcDay(now()));

  // An intent that already carries a registry identity skips resolution. The
  // surface usually resolved it already; we do not assume so.
  const intent = input.companyId ? await store.getCompany(input.companyId) : null;
  if (input.companyId && !intent) {
    throw new LookupInputError(`no company ${JSON.stringify(input.companyId)} to look up`);
  }
  const preresolved = intent !== null && hasRegistryIdentity(intent);

  // 0. Ceilings, before ANY fetch -- resolution fetches too.
  const projected = LOOKUP_PASS_CREDITS + (preresolved ? 0 : RESOLUTION_CREDITS);
  const lookupSpent = await store.creditsSpentOnLookups();
  if (lookupSpent + projected > deps.lookupCeiling) {
    log('lookup_ceiling_hit', { spent: lookupSpent, projected, ceiling: deps.lookupCeiling });
    return emptyOutcome('over_ceiling', {
      company_id: input.companyId ?? null,
      reason: `Lookups have spent ${lookupSpent} of ${deps.lookupCeiling} credits and this one needs ~${projected}.`,
    });
  }
  if (deps.creditCeiling !== undefined) {
    const total = await store.creditsSpentTotal();
    if (total + projected > deps.creditCeiling) {
      log('credit_ceiling_hit', { credits_spent: total, projected, ceiling: deps.creditCeiling });
      return emptyOutcome('over_ceiling', {
        company_id: input.companyId ?? null,
        reason: `The book has spent ${total} of ${deps.creditCeiling} credits and this lookup needs ~${projected}.`,
      });
    }
  }

  // 1. Resolve -- the same two rules resolvePending lives by.
  let companyId: string;
  let resolution: NonNullable<LookupOutcome['resolution']>;
  if (preresolved) {
    companyId = input.companyId!;
    const r = (intent!['resolution'] ?? {}) as Record<string, unknown>;
    resolution = {
      status: 'preresolved',
      confidence: typeof r['confidence'] === 'number' ? r['confidence'] : null,
      reason: typeof r['reason'] === 'string' ? r['reason'] : '',
      candidates_seen: Array.isArray(r['candidates_seen']) ? r['candidates_seen'] as Record<string, unknown>[] : [],
    };
  } else {
    const name = input.name;
    const jurisdiction = input.country;
    const [candidatesResult, identityResult] = await Promise.allSettled([
      deps.candidates.search({ name, jurisdiction }),
      deps.candidates.identify({ name, jurisdiction }),
    ]);
    const identity = identityResult.status === 'fulfilled' ? identityResult.value : { domains: [], aliases: [] };

    if (candidatesResult.status === 'rejected') {
      // An unreachable registry is not an absent company: say we could not
      // look, and name the error, rather than `no_match`, which implies we did.
      const reason = `The company registry could not be searched, so no candidate was considered: ${errText(candidatesResult.reason)}`;
      if (input.companyId) await store.setResolution(input.companyId, { confidence: null, reason });
      log('lookup_source_failed', { name, error: errText(candidatesResult.reason) });
      return emptyOutcome('could_not_look', {
        company_id: input.companyId ?? null,
        resolution: { status: 'could_not_look', confidence: null, reason, candidates_seen: [] },
        reason,
      });
    }

    const candidates = candidatesResult.value;
    const deal = { counterparty_name: name, country: jurisdiction };
    const judgement = await deps.judge.resolve({
      deal, candidates, domains: identity.domains, aliases: identity.aliases,
    });
    const outcome = outcomeFor(deal, candidates, judgement, identity.domains);

    if (outcome.status === 'needs_review') {
      // Park rather than guess. A profile of the wrong company, handed over at
      // the moment someone decides whether to sign, is worse than no answer --
      // and we do not spend a pass on a company we could not identify.
      if (input.companyId) {
        await store.setResolution(input.companyId, {
          confidence: outcome.resolution.confidence,
          reason: outcome.resolution.reason,
          candidates_seen: outcome.resolution.candidates_seen,
        });
      }
      log('lookup_needs_review', { name, candidates: candidates.length, confidence: outcome.resolution.confidence });
      return emptyOutcome('needs_review', {
        company_id: input.companyId ?? null,
        resolution: {
          status: 'needs_review',
          confidence: outcome.resolution.confidence,
          reason: outcome.resolution.reason,
          candidates_seen: outcome.resolution.candidates_seen,
        },
        reason: outcome.resolution.reason,
      });
    }

    // 2. Upsert by registry id, with `lookup` and WITHOUT monitoring_since:
    // that field is what the loop and the rollup read as "being watched".
    const resolvedAt = now().toISOString();
    const upserted = await store.upsertCompany({
      ...(input.companyId ? { company_id: input.companyId } : {}),
      canonical_name: outcome.canonical_name,
      jurisdiction: outcome.jurisdiction,
      registry_id: outcome.registry_id,
      aliases: outcome.aliases,
      domains: outcome.domains,
      officers: outcome.officers,
      related_entities: outcome.related_entities,
      resolution: {
        confidence: outcome.resolution.confidence,
        reason: outcome.resolution.reason,
        resolved_by: outcome.resolution.resolved_by,
        candidates_seen: outcome.resolution.candidates_seen,
        resolved_at: resolvedAt,
      },
      lookup: { requested_at: resolvedAt, requested_by: input.requestedBy, watch_until: watchUntil },
    });
    companyId = upserted.company_id;
    // An intent moved onto its real registry key keeps the resolution the
    // surface wrote; record ours, since it is the one we acted on.
    if (input.companyId && upserted.outcome === 'backfilled') {
      await store.setResolution(companyId, {
        confidence: outcome.resolution.confidence,
        reason: outcome.resolution.reason,
        candidates_seen: outcome.resolution.candidates_seen,
      });
    }
    resolution = {
      status: 'resolved',
      confidence: outcome.resolution.confidence,
      reason: outcome.resolution.reason,
      candidates_seen: outcome.resolution.candidates_seen,
    };
  }

  const company = await store.getCompany(companyId);
  if (!company) throw new Error(`runLookup: company ${companyId} vanished after upsert`);

  // Registry ids are the key, so a lookup can land on a company already in the
  // book. A monitored company is already watched forever; a prospect we already
  // profiled is not collected again (only an explicit watch adds anything).
  if (company['monitoring_since']) {
    return emptyOutcome('already_monitored', { company_id: companyId, resolution });
  }
  if (company['last_checked_at']) {
    const profile = await store.latestBriefing(companyId, 'profile');
    const written = watchUntil ? await writeWatch(store, companyId, watchUntil, now()) : 0;
    return emptyOutcome('already_collected', {
      company_id: companyId, resolution, schedules_written: written,
      briefing_id: profile ? String(profile['briefing_id']) : null,
      coverage: (company['coverage'] as Coverage | undefined) ?? null,
    });
  }

  // 3. One batch, every source, one pass. Nothing about collection changes.
  const batch = batchId(companyId, utcDay(now()));
  const result = await runBatch(companyId, [...SOURCES], batch, { ...deps.batch, store });

  const runs: LookupRun[] = (await store.runsForBatch(batch)).map((r) => ({
    source: r.source, status: r.status, credits_spent: r.credits_spent ?? 0, error: r.error ?? null,
  }));
  const credits_spent = runs.reduce((sum, r) => sum + r.credits_spent, 0);

  // 4. Schedules only for a bounded watch. Written AFTER the batch, so the
  // one-shot path runs with no schedule document at all and runBatch's
  // pushSchedule() is a no-op against nothing.
  const schedules_written = watchUntil ? await writeWatch(store, companyId, watchUntil, now()) : 0;

  // 5. The first run is a baseline. Assert it rather than trust it.
  const signals = await store.signalsForCompany(companyId);
  const profile = await store.latestBriefing(companyId, 'profile');
  const alert = await store.latestBriefing(companyId, 'briefing');
  const baseline_violations = baselineViolations(result.changes, signals, profile, alert);
  if (baseline_violations.length > 0) {
    log('lookup_not_baseline', { company_id: companyId, violations: baseline_violations });
  }

  log('lookup_profiled', { company_id: companyId, credits_spent, schedules_written });
  return {
    status: 'profiled',
    company_id: companyId,
    resolution,
    runs,
    briefing_id: profile ? String(profile['briefing_id']) : null,
    coverage: result.coverage,
    credits_spent,
    schedules_written,
    baseline_violations,
  };
}

/**
 * The loop's lookup poll: one intent document becomes one runLookup call. One
 * per tick, never batched -- the safer default against the credit ceiling.
 * Returns the outcome, or null when there was nothing to look up.
 */
export interface LookupPollStore extends LookupStore {
  lookupIntents(limit?: number): Promise<Array<Record<string, unknown>>>;
}

export async function lookupPending(
  deps: Omit<LookupDeps, 'store'> & { store: LookupPollStore },
): Promise<LookupOutcome | null> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const [intent] = await deps.store.lookupIntents(1);
  if (!intent) return null;

  const lookup = (intent['lookup'] ?? {}) as Record<string, unknown>;
  let watchUntil = typeof lookup['watch_until'] === 'string' ? lookup['watch_until'] : null;
  // The loop may pick an intent up after its watch already ended. It is still
  // worth a profile; it is not worth a schedule.
  if (watchUntil !== null && watchUntil < utcDay(now())) {
    log('lookup_watch_already_ended', { company_id: intent['company_id'], watch_until: watchUntil });
    watchUntil = null;
  }
  return runLookup({
    name: String(intent['canonical_name'] ?? ''),
    country: String(intent['jurisdiction'] ?? ''),
    requestedBy: String(lookup['requested_by'] ?? ''),
    watchUntil,
    companyId: String(intent['company_id']),
  }, deps);
}

/**
 * promoteToDeal: the prospect was signed.
 *
 * Companies upsert by registry id, so the deal reuses the looked-up record.
 * The diligence snapshots are already the newest `ok` snapshot per (company,
 * source), so they ARE the monitoring baseline with no copying: day one of
 * monitoring starts with history. `lookup` stays -- both fields present is
 * what tells a reader this company was diligenced before it was signed.
 */
export interface PromoteStore {
  getCompany(companyId: string): Promise<Record<string, unknown> | null>;
  dealsForCompany(companyId: string): Promise<Array<Record<string, unknown>>>;
  linkDealToCompany(input: {
    deal_id: string; company_id: string; confidence: number | null;
    reason: string; candidates_seen?: Record<string, unknown>[];
  }): Promise<boolean>;
  setMonitoringSince(companyId: string, day: string): Promise<string>;
  upsertSchedule(input: ScheduleWrite): Promise<void>;
}

export interface PromoteOutcome {
  company_id: string;
  deal_id: string;
  linked: 'linked' | 'already_linked';
  monitoring_since: string;
  schedules_written: number;
}

export async function promoteToDeal(
  companyId: string,
  dealId: string,
  deps: { store: PromoteStore; now?: () => Date },
): Promise<PromoteOutcome> {
  const now = deps.now ?? (() => new Date());
  const { store } = deps;
  const company = await store.getCompany(companyId);
  if (!company) throw new Error(`promoteToDeal: no company ${JSON.stringify(companyId)}`);

  const r = (company['resolution'] ?? {}) as Record<string, unknown>;
  const linked = await store.linkDealToCompany({
    deal_id: dealId,
    company_id: companyId,
    confidence: typeof r['confidence'] === 'number' ? r['confidence'] : null,
    reason: typeof r['reason'] === 'string' && r['reason'] !== ''
      ? r['reason']
      : 'Linked to the company looked up before signing.',
    candidates_seen: Array.isArray(r['candidates_seen']) ? r['candidates_seen'] as Record<string, unknown>[] : [],
  });
  // linkDealToCompany only moves an `unresolved` deal. Already linked here is
  // a retry and fine; anything else is a deal we must not silently re-point.
  if (!linked) {
    const mine = (await store.dealsForCompany(companyId)).some((d) => d['deal_id'] === dealId);
    if (!mine) {
      throw new Error(
        `promoteToDeal: deal ${JSON.stringify(dealId)} is not unresolved and not linked to ${companyId}; refusing to re-point it.`,
      );
    }
  }

  const at = now();
  const monitoring_since = await store.setMonitoringSince(companyId, utcDay(at));
  // Normal cadence, no expiry, next_run_at NOW. The first monitored batch
  // diffs against the diligence snapshots, so it can alert -- that is the point.
  for (const source of SOURCES) {
    await store.upsertSchedule({
      company_id: companyId, source, cadence: CADENCE[source],
      next_run_at: at.toISOString(), enabled: true, expires_at: null,
    });
  }
  return {
    company_id: companyId, deal_id: dealId,
    linked: linked ? 'linked' : 'already_linked',
    monitoring_since, schedules_written: SOURCES.length,
  };
}

/** A watch includes the whole of its last day: it expires at the next midnight UTC. */
export function watchExpiresAt(watchUntil: string): string {
  const d = new Date(`${watchUntil}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

async function writeWatch(store: LookupStore, companyId: string, watchUntil: string, at: Date): Promise<number> {
  const expires_at = watchExpiresAt(watchUntil);
  for (const source of SOURCES) {
    // The lookup batch just ran, so the first watched run is one cadence out.
    const hours = CADENCE[source] === 'weekly' ? 24 * 7 : 24;
    await store.upsertSchedule({
      company_id: companyId, source, cadence: CADENCE[source],
      next_run_at: new Date(at.getTime() + hours * 3_600_000).toISOString(),
      enabled: true, expires_at,
    });
  }
  return SOURCES.length;
}

function assertWatchUntil(watchUntil: string, today: string): void {
  if (!DATE_ONLY.test(watchUntil) || Number.isNaN(Date.parse(`${watchUntil}T00:00:00Z`))) {
    throw new LookupInputError(`watchUntil must be a date like 2026-11-30, got ${JSON.stringify(watchUntil)}`);
  }
  if (watchUntil < today) {
    throw new LookupInputError(`watchUntil ${watchUntil} is already over (today is ${today})`);
  }
}

function hasRegistryIdentity(company: Record<string, unknown>): boolean {
  const id = String(company['registry_id'] ?? '').trim();
  const key = String(company['registry_key'] ?? '');
  return id !== '' && !key.startsWith('MANUAL:');
}

function baselineViolations(
  changes: number,
  signals: readonly Signal[],
  profile: Record<string, unknown> | null,
  alert: Record<string, unknown> | null,
): string[] {
  const out: string[] = [];
  if (changes > 0) out.push(`the differ emitted ${changes} change(s) on a first run`);
  const live = signals.filter((s) => s.status !== 'baseline');
  if (live.length > 0) {
    out.push(`non-baseline signals on a first run: ${live.map((s) => `${s.type}:${s.status}:t${s.tier}`).join(', ')}`);
  }
  if (alert) out.push(`a 'briefing'-mode briefing was written on a first run (${String(alert['briefing_id'])})`);
  if (signals.length > 0 && !profile) out.push('baseline signals exist but no profile briefing was written');
  if (profile) {
    if (profile['mode'] !== 'profile') out.push(`profile briefing has mode ${String(profile['mode'])}`);
    const titles = Array.isArray(profile['sections'])
      ? (profile['sections'] as Array<Record<string, unknown>>).map((s) => s['title'])
      : [];
    if (JSON.stringify(titles) !== JSON.stringify([...PROFILE_SECTION_TITLES])) {
      out.push(`profile sections are ${JSON.stringify(titles)}, not the four profile titles`);
    }
  }
  return out;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
