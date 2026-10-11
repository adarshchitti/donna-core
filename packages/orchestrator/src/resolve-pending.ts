import { SOURCES, isoNow, type Source, type Deal } from '@donna/contracts';
import { CADENCE } from './loop.js';
import { outcomeFor, type Judge, type RegistryCandidate } from './resolution.js';

/**
 * resolvePending: unresolved deals become monitored companies.
 *
 * This is where a name somebody typed into a spreadsheet becomes a legal entity
 * we will report on for months. A wrong match here makes every later step
 * confidently wrong -- we would monitor a different company and attribute its
 * changes to this agreement -- so the whole function is built around refusing
 * to guess.
 *
 * On success it also writes the schedules, with `next_run_at: now`, so the
 * company's first batch fires on the next loop tick. THAT FIRST BATCH IS THE
 * PROFILE: the differ finds no baseline, emits no changes, and the validator
 * turns the snapshot items into baseline signals instead.
 */

export interface CandidateSource {
  /** Registry candidates for a name in a jurisdiction, via Bright Data. */
  search(input: { name: string; jurisdiction: string }): Promise<RegistryCandidate[]>;
  /** Official domain and obvious aliases, via SERP. */
  identify(input: { name: string; jurisdiction: string }): Promise<{ domains: string[]; aliases: string[] }>;
}

export interface ResolveStore {
  unresolvedDeals(limit?: number): Promise<Deal[]>;
  upsertCompany(input: Record<string, unknown>): Promise<{ company_id: string; outcome: string }>;
  linkDealToCompany(input: {
    deal_id: string; company_id: string; confidence: number | null;
    reason: string; candidates_seen?: Record<string, unknown>[];
  }): Promise<boolean>;
  parkDealForReview(input: {
    deal_id: string; reason: string; candidates_seen?: Record<string, unknown>[];
  }): Promise<boolean>;
  upsertSchedule(input: {
    company_id: string; source: Source; cadence: 'daily' | 'weekly';
    next_run_at: string; enabled?: boolean;
  }): Promise<void>;
}

export interface ResolvePendingDeps {
  store: ResolveStore;
  candidates: CandidateSource;
  judge: Judge;
  /** Cap per tick so one bad batch of intake cannot monopolise the loop. */
  limit?: number;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface ResolveReport {
  considered: number;
  resolved: number;
  needs_review: number;
  failed: number;
}

export async function resolvePending(deps: ResolvePendingDeps): Promise<ResolveReport> {
  const log = deps.log ?? (() => {});
  const deals = await deps.store.unresolvedDeals(deps.limit ?? 10);
  const report: ResolveReport = { considered: deals.length, resolved: 0, needs_review: 0, failed: 0 };

  for (const deal of deals) {
    try {
      const name = deal.counterparty_name;
      const jurisdiction = deal.country;

      // Candidate gathering and identification are independent, and a failure
      // in either must not abort the other: resolution can proceed on registry
      // candidates with no domain, and SERP is the less reliable of the two.
      const [candidatesResult, identityResult] = await Promise.allSettled([
        deps.candidates.search({ name, jurisdiction }),
        deps.candidates.identify({ name, jurisdiction }),
      ]);

      const candidates = candidatesResult.status === 'fulfilled' ? candidatesResult.value : [];
      const identity = identityResult.status === 'fulfilled'
        ? identityResult.value
        : { domains: [], aliases: [] };

      if (candidatesResult.status === 'rejected') {
        // A source we could not reach is not a company that does not exist.
        // Park it for a person and say why, rather than recording `no_match`
        // and implying we looked.
        await deps.store.parkDealForReview({
          deal_id: deal.deal_id,
          reason: `The company registry could not be searched, so no candidate was considered: ${errText(candidatesResult.reason)}`,
        });
        report.needs_review += 1;
        log('resolution_source_failed', { deal_id: deal.deal_id, error: errText(candidatesResult.reason) });
        continue;
      }

      const judgement = await deps.judge.resolve({
        deal: { counterparty_name: name, country: jurisdiction },
        candidates,
        domains: identity.domains,
        aliases: identity.aliases,
      });

      const outcome = outcomeFor(
        { counterparty_name: name, country: jurisdiction },
        candidates,
        judgement,
        identity.domains,
      );

      if (outcome.status === 'needs_review') {
        await deps.store.parkDealForReview({
          deal_id: deal.deal_id,
          reason: outcome.resolution.reason,
          candidates_seen: outcome.resolution.candidates_seen,
        });
        report.needs_review += 1;
        log('resolution_needs_review', {
          deal_id: deal.deal_id, candidates: candidates.length,
          confidence: outcome.resolution.confidence,
        });
        continue;
      }

      // Upsert by (book_id, jurisdiction, registry_key), so two deals naming the
      // same company converge on one record rather than monitoring it twice.
      const upserted = await deps.store.upsertCompany({
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
          resolved_at: isoNow(),
        },
        monitoring_since: isoNow().slice(0, 10),
      });

      const linked = await deps.store.linkDealToCompany({
        deal_id: deal.deal_id,
        company_id: upserted.company_id,
        confidence: outcome.resolution.confidence,
        reason: outcome.resolution.reason,
        candidates_seen: outcome.resolution.candidates_seen,
      });

      if (!linked) {
        // Someone resolved it by hand between our read and our write. Their
        // decision wins; the company upsert is harmless and idempotent.
        log('resolution_lost_race', { deal_id: deal.deal_id });
        continue;
      }

      // Schedules last, and only for a company that actually got linked, so a
      // failed link never leaves collection running against nothing.
      // next_run_at is NOW: the first batch is the profile.
      const now = isoNow();
      for (const source of SOURCES) {
        await deps.store.upsertSchedule({
          company_id: upserted.company_id,
          source,
          cadence: CADENCE[source],
          next_run_at: now,
          enabled: true,
        });
      }

      report.resolved += 1;
      log('resolved', {
        deal_id: deal.deal_id, company_id: upserted.company_id,
        outcome: upserted.outcome, confidence: outcome.resolution.confidence,
      });
    } catch (error) {
      // One bad deal must not stop the rest, and must not silently vanish.
      report.failed += 1;
      log('resolution_failed', { deal_id: deal.deal_id, error: errText(error) });
    }
  }

  return report;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
