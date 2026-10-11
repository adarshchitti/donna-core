import { randomUUID } from 'node:crypto';
import {
  SOURCES, SOURCE_LABELS, SOURCE_TRUST, NOT_COVERED_CATEGORIES,
  snapshotId, runId, batchId, utcDay, isoNow,
  type Source, type Coverage,
} from '@donna/contracts';
import type { DonnaStore } from './store.js';

/**
 * Demo seeding, in two strictly separated halves.
 *
 * 1. `seedRealCompanies` writes the fixed universe: 30 real Ohio companies,
 *    IDENTITY ONLY, plus the schedules that make collection start. Their
 *    signals then come from actual collection runs against actual sources.
 *
 * 2. `seedDemonstrationCompany` writes one obviously-fictional company with a
 *    full worked set of signals, a cluster and a briefing, for exercising the
 *    UI before real data exists.
 *
 * The halves are separate because of a rule this product cannot bend: we do not
 * fabricate observations about real named companies. Writing "Big Lots filed
 * Chapter 11" with an invented court excerpt and a fake snapshot id would be
 * fabricated evidence about a real business, on a product whose whole claim is
 * that every line opens to the page it came from. Three of the thirty really
 * did file Chapter 11, which makes it tempting and makes it worse: a reader
 * could not tell our invention from the real filing.
 *
 * So real companies get real collection, and invented records belong to an
 * invented company whose name says so.
 */

/** Stamped on everything seeded, so a demo record is always distinguishable. */
export const SEED_MARKER = 'seeded_demo';

export interface RealCompanyInput {
  canonical_name: string;
  registry_id?: string;
  jurisdiction: string;
  domains?: string[];
  aliases?: string[];
  notes?: string;
}

export interface SeedReport {
  companies: number;
  schedules: number;
  skipped: string[];
}

/**
 * The fixed universe: identity and schedules, no invented observations.
 *
 * Schedules carry `next_run_at: now`, so each company's first batch fires on
 * the next orchestrator tick -- and that first batch is the profile, not an
 * alert.
 */
export async function seedRealCompanies(
  store: DonnaStore,
  companies: readonly RealCompanyInput[],
  cadence: Record<Source, 'daily' | 'weekly'>,
): Promise<SeedReport> {
  const report: SeedReport = { companies: 0, schedules: 0, skipped: [] };
  const now = isoNow();

  // Companies seeded by name have no registration, so the store derives a
  // `MANUAL:<uuid>` upsert key -- a DIFFERENT one on every run. Left alone,
  // re-seeding would duplicate all thirty, and the orchestrator would then
  // collect each twice and double the credit spend against a 300-credit budget.
  // So dedupe on (canonical_name, jurisdiction) before upserting.
  const seen = new Map<string, string>();
  for (const existing of await store.listCompanies()) {
    seen.set(nameKey(existing.canonical_name, existing.jurisdiction), existing.company_id);
  }

  for (const input of companies) {
    if (!/^[A-Z]{2}$/.test(input.jurisdiction)) {
      // The Base44 backend throws when a deal's country does not match the
      // entity's jurisdiction, so a malformed one is a future 500, not a
      // cosmetic problem.
      report.skipped.push(`${input.canonical_name}: jurisdiction must be 2-letter uppercase`);
      continue;
    }

    const key = nameKey(input.canonical_name, input.jurisdiction);
    const already = seen.get(key);
    if (already) {
      // Already in the book. Keep its schedules current and move on, so a
      // re-run is a no-op rather than a second copy.
      for (const source of SOURCES) {
        await store.upsertSchedule({
          company_id: already, source, cadence: cadence[source], next_run_at: now, enabled: true,
        });
        report.schedules += 1;
      }
      continue;
    }

    const { company_id } = await store.upsertCompany({
      canonical_name: input.canonical_name,
      jurisdiction: input.jurisdiction,
      registry_id: input.registry_id ?? '',
      aliases: input.aliases ?? [],
      domains: input.domains ?? [],
      resolution: {
        confidence: null,
        // Honest about provenance: these were chosen by hand for data
        // availability, not matched against a registry. Entity resolution will
        // fill in the registration and raise the confidence when it runs.
        reason: input.registry_id
          ? 'Seeded from the fixed universe with a recorded registration. Not independently verified.'
          : 'Seeded from the fixed universe by name only. No registration confirmed, so entity resolution has not run and no registry match is claimed.',
        resolved_by: SEED_MARKER,
        candidates_seen: [],
      },
      monitoring_since: utcDay(),
    });
    report.companies += 1;
    seen.set(key, company_id);

    for (const source of SOURCES) {
      await store.upsertSchedule({
        company_id, source, cadence: cadence[source], next_run_at: now, enabled: true,
      });
      report.schedules += 1;
    }
  }
  return report;
}

/**
 * Coverage assembled from what actually happened to each source.
 *
 * `checked`/`failed` are source IDS; `not_covered` are human LABELS, carrying
 * the four things this system never observes plus any source never attempted.
 * A source that failed appears under `failed` and NOT under `checked`, because
 * a broken collector is a visible gap and never silence.
 */
export function demoCoverage(checked: Source[], failed: Source[]): Coverage {
  const attempted = new Set([...checked, ...failed]);
  return {
    checked: [...checked],
    failed: [...failed],
    not_covered: [
      ...NOT_COVERED_CATEGORIES,
      ...SOURCES.filter((s) => !attempted.has(s)).map((s) => SOURCE_LABELS[s]),
    ],
    as_of: isoNow(),
  };
}

/** Stable identity for a company seeded by name, with no registration. */
function nameKey(canonicalName: string, jurisdiction: string): string {
  return `${jurisdiction.toUpperCase()}::${canonicalName.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

export const demoIds = { snapshotId, runId, batchId, newCompanyId: () => randomUUID() };
export { SOURCE_TRUST };

// ---------------------------------------------------------------------------
// The demonstration company. Invented, and named so nobody can mistake it.
// ---------------------------------------------------------------------------

export interface DemoCompanySpec {
  /** Must announce itself as a demonstration record in the name itself. */
  canonical_name: string;
  registry_id: string;
  jurisdiction: string;
  checked: Source[];
  failed: Source[];
  signals: DemoSignalSpec[];
  /** Omitted for the quiet company: there is deliberately no cluster and no briefing. */
  briefing?: { headline: string; why_it_matters: string; verify: string | null; confidence_note: string };
  top_tier: 0 | 1 | 2 | 3;
}

export interface DemoSignalSpec {
  type: string;
  title: string;
  tier: 0 | 1 | 2 | 3;
  confidence: 'high' | 'medium' | 'low';
  status: 'baseline' | 'reported' | 'confirmed' | 'inferred';
  source: Source;
  /** The exact text a claim points to. A user clicks through to read this. */
  excerpt: string;
  summary_fact: string;
  first_seen: string;
  touches_terms?: string[];
}

export interface DemoSeedResult {
  company_id: string;
  snapshots: number;
  signals: number;
  runs: number;
  narrated: boolean;
}

/**
 * Writes one fictional company with a complete, self-consistent record set:
 * runs, snapshots, signals, a cluster and a briefing.
 *
 * Self-consistent matters more than it sounds. Track C silently drops any
 * briefing line whose signal_id is missing from its cluster, rendering "0 cited
 * observations" and an empty panel -- so the cluster's signal list and the
 * briefing's citations are derived from the same source here rather than
 * written twice.
 */
export async function seedDemonstrationCompany(
  store: DonnaStore,
  spec: DemoCompanySpec,
): Promise<DemoSeedResult> {
  if (!/demonstration|example|sample|fictional/i.test(spec.canonical_name)) {
    // A fabricated record under a plausible real name is the one thing this
    // product must never produce, so the guard is a throw, not a warning.
    throw new Error(
      `refusing to seed invented observations under "${spec.canonical_name}": a ` +
      `demonstration company's name must say so, or a reader cannot tell it ` +
      `from a real counterparty`,
    );
  }

  const now = isoNow();
  const day = utcDay();

  const { company_id } = await store.upsertCompany({
    canonical_name: spec.canonical_name,
    jurisdiction: spec.jurisdiction,
    registry_id: spec.registry_id,
    aliases: [],
    domains: [],
    resolution: {
      confidence: null,
      reason: 'Fictional demonstration record. No registry was searched and no source was fetched.',
      resolved_by: SEED_MARKER,
      candidates_seen: [],
    },
    monitoring_since: day,
  });

  const batch = batchId(company_id, day);
  let snapshots = 0;
  let runs = 0;

  // One run per attempted source. A failed source gets a run row and NO
  // snapshot: a failure is recorded and shown as a coverage gap, never as an
  // empty result that reads like "nothing happened".
  for (const source of [...spec.checked, ...spec.failed]) {
    const failed = spec.failed.includes(source);
    const handle = await store.startRun({
      run_id: runId(company_id, source), batch_id: batch, company_id, source,
      started_at: now, sandbox_id: `demo-seed-${source}`, cache_hit: false,
    });
    runs += 1;

    if (failed) {
      await store.finishRun(handle, {
        status: 'failed',
        error: 'DEMONSTRATION GAP: this source was not fetched. A failed source is shown as a gap, never as silence.',
        ended_at: now, credits_spent: 0,
      });
      continue;
    }

    const forSource = spec.signals.filter((s) => s.source === source);
    await store.insertSnapshot({
      snapshot_id: snapshotId(company_id, source, now),
      company_id, source, fetched_at: now, run_id: runId(company_id, source),
      items: forSource.map((s) => ({ key: `${s.type}:${s.first_seen}`, type: s.type, summary: s.summary_fact })),
      raw_excerpt: forSource.map((s) => s.excerpt).join('\n\n')
        || `Fictional ${SOURCE_LABELS[source].toLowerCase()} check. No items returned.`,
      source_url: `https://donna-demonstration.invalid/${source}/${company_id}`,
      ok: true,
    });
    snapshots += 1;
  }

  const signalIds: string[] = [];
  for (const s of spec.signals) {
    const { signal_id } = await store.upsertSignal({
      company_id, type: s.type, title: s.title, tier: s.tier,
      confidence: s.confidence, status: s.status,
      evidence: [{
        snapshot_id: snapshotId(company_id, s.source, now),
        source: s.source, trust: SOURCE_TRUST[s.source],
        excerpt: s.excerpt,
        url: `https://donna-demonstration.invalid/${s.source}/${company_id}`,
      }],
      first_seen: s.first_seen,
      summary_fact: s.summary_fact,
      touches_terms: s.touches_terms ?? [],
    });
    // Baseline signals are a starting state, not something that happened, so
    // they are excluded from the cluster the narrator cites.
    if (s.status !== 'baseline' && s.tier > 0) signalIds.push(signal_id);
  }

  const coverage = demoCoverage(spec.checked, spec.failed);
  await store.setCoverage(company_id, coverage);

  // The quiet company: no cluster, no briefing. Its page must read as the
  // coverage sentence -- "no change observed across N sources since T" -- which
  // is the product's actual thesis and the state nobody has ever user-tested.
  if (!spec.briefing || signalIds.length === 0) {
    return { company_id, snapshots, signals: spec.signals.length, runs, narrated: false };
  }

  const cluster_id = `cl-${company_id}`;
  const fingerprint = `demo-${signalIds.join('+')}`;
  await store.putCluster({
    cluster_id, company_id, mode: 'briefing',
    window: { from: day, to: day },
    top_tier: spec.top_tier, verify_with_counterparty: spec.top_tier === 1,
    signals: signalIds, deals: [],
    exposure: { top_weight: 0, annual_value_usd: 0 },
    coverage, fingerprint,
  });

  const cited = spec.signals.filter((s) => signalIds.includes(
    // recompute the id the same way upsertSignal did
    `sig-${company_id}-${s.type}-${s.first_seen}`,
  ));
  const lines = (cited.length > 0 ? cited : spec.signals.filter((s) => s.tier > 0 && s.status !== 'baseline'))
    .map((s, i) => ({ text: s.summary_fact, signal_id: signalIds[i] ?? signalIds[0]! }));

  await store.putBriefing({
    briefing_id: `br-${company_id}`, company_id, mode: 'briefing',
    headline: spec.briefing.headline,
    what_changed: lines,
    why_it_matters: spec.briefing.why_it_matters,
    verify: spec.briefing.verify,
    confidence_note: spec.briefing.confidence_note,
    coverage,
    generated_at: now,
    citations: {
      headline: signalIds.slice(0, 1), why_it_matters: signalIds,
      deal_context: [], verify: spec.top_tier === 1 ? signalIds.slice(0, 1) : [],
      confidence_note: signalIds,
    },
    narration_status: 'available',
    cluster_id,
  });

  return { company_id, snapshots, signals: spec.signals.length, runs, narrated: true };
}
