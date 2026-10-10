import { createHash } from 'node:crypto';
import {
  clusterId, clusterSchema, NOT_COVERED_CATEGORIES,
  type Cluster, type Confidence, type Coverage, type Signal, type Tier,
} from '@donna/contracts';
import { loadRules, type Rules } from './rules.js';
import { confidenceRank } from './trust.js';
import { addDays } from './dates.js';
import type { CompanyExposure } from './exposure.js';

/**
 * Step 5 -- cluster, promote, order.
 *
 * NO COMPOSITE SCORE ANYWHERE. Ordering is lexicographic: tier first, then
 * exposure weight, then confidence. A tier 3 never outranks a tier 1 however
 * large the deal, because a finance person expects severity to come first and
 * can check the ordering by hand. The moment we multiply a tier by a weight,
 * nobody can say why item 4 is above item 5, and the first wrong-looking sort
 * costs us the user's trust in everything else on the page.
 */

/** Tier 1 is the most severe, so tiers sort ASCENDING -- except 0, which never alerts. */
const TIER_SEVERITY: Record<Tier, number> = { 1: 0, 2: 1, 3: 2, 0: 3 };

export interface Ranked {
  tier: Tier;
  exposure_weight: number;
  confidence: Confidence;
}

/** The comparator. Lexicographic, three keys, no arithmetic between them. */
export const compareRanked = (a: Ranked, b: Ranked): number => {
  if (a.tier !== b.tier) return TIER_SEVERITY[a.tier] - TIER_SEVERITY[b.tier];
  if (a.exposure_weight !== b.exposure_weight) return b.exposure_weight - a.exposure_weight;
  return confidenceRank(b.confidence) - confidenceRank(a.confidence);
};

/** Signals within one company share its exposure, so the weight is passed in. */
export const compareSignals = (
  a: Signal,
  b: Signal,
  weightFor: (s: Signal) => number = () => 0,
): number =>
  compareRanked(
    { tier: a.tier, exposure_weight: weightFor(a), confidence: a.confidence },
    { tier: b.tier, exposure_weight: weightFor(b), confidence: b.confidence },
  );

/**
 * Does this signal surface at all?
 *  - tier 1: always, whatever the exposure. An ownership change matters even
 *    on a small contract.
 *  - tier 2: only once the top linked-deal exposure clears the threshold.
 *  - tier 3: survives into the window, where three of them make a pattern.
 *  - tier 0: stored, never alerted.
 */
export const surfaces = (
  signal: Signal,
  topExposureWeight: number,
  rules: Rules = loadRules(),
): boolean => {
  if (signal.tier === 0) return false;
  if (signal.tier === 1) return true;
  if (signal.tier === 2) return topExposureWeight >= rules.thresholds.tier2_min_exposure_weight;
  return true;
};

/**
 * Hash of the sorted signal ids AND their statuses. The narrator runs only
 * when this differs from the last briefing's, which is what stops the same
 * cluster being narrated 14 days running -- and why status belongs in the
 * hash: `reported` becoming `confirmed` is new information even though the
 * signal set is unchanged.
 */
export const fingerprint = (
  signals: readonly Pick<Signal, 'signal_id' | 'status'>[],
): string => {
  const body = signals
    .map((s) => `${s.signal_id}:${s.status}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(body).digest('hex').slice(0, 32);
};

export const EMPTY_COVERAGE: Coverage = {
  checked: [],
  failed: [],
  not_covered: [...NOT_COVERED_CATEGORIES],
};

export interface BuildClusterInput {
  book_id: string;
  company_id: string;
  mode: Cluster['mode'];
  /** Every signal in the rolling window, surfaced or not. */
  signals: readonly Signal[];
  exposure: CompanyExposure;
  coverage?: Coverage;
  today: string;
  rules?: Rules;
}

export interface BuildClusterResult {
  cluster: Cluster | null;
  surfaced: Signal[];
  /** True when three or more tier 3 signals promoted the cluster. */
  promoted_by_pattern: boolean;
}

export const buildCluster = (input: BuildClusterInput): BuildClusterResult => {
  const rules = input.rules ?? loadRules();
  const topWeight = input.exposure.top_weight;

  const baseline = input.mode === 'profile';
  const surfaced = baseline
    ? input.signals.filter((s) => s.status === 'baseline')
    : input.signals.filter((s) => surfaces(s, topWeight, rules));

  if (surfaced.length === 0) return { cluster: null, surfaced: [], promoted_by_pattern: false };

  const tier3Count = surfaced.filter((s) => s.tier === 3).length;
  const promoted = !baseline && tier3Count >= rules.thresholds.tier3_pattern_count;

  const naturalTop = surfaced.reduce<Tier>(
    (top, s) => (TIER_SEVERITY[s.tier] < TIER_SEVERITY[top] ? s.tier : top),
    0,
  );
  // Three or more tier 3 signals in the window promote the CLUSTER (not the
  // individual signals) to tier 2: each one alone explains nothing, together
  // they are a pattern worth a sentence.
  const topTier: Tier = promoted && TIER_SEVERITY[naturalTop] > TIER_SEVERITY[2] ? 2 : naturalTop;

  const inCluster = surfaced.filter((s) => {
    if (baseline) return true;
    const min = rules.cluster.min_tier_in_cluster;
    const max = rules.cluster.max_tier_in_cluster;
    if (s.tier >= min && s.tier <= max) return true;
    // Without this, a cluster promoted purely by a tier 3 pattern would cite
    // nothing and the narrator would have no signal to point at.
    return promoted && s.tier === 3 && rules.cluster.include_tier3_signal_ids_when_promoted;
  });

  // Nothing citable means no cluster at all. A lone tier 3 surfaces "only as
  // part of a pattern", so without the pattern there is nothing to narrate and
  // an empty cluster.signals would only give the narrator a document to
  // dereference and find nothing in.
  if (inCluster.length === 0) {
    return { cluster: null, surfaced: [...surfaced], promoted_by_pattern: promoted };
  }

  const ordered = [...inCluster].sort((a, b) => compareSignals(a, b, () => topWeight));

  const cluster = clusterSchema.parse({
    book_id: input.book_id,
    cluster_id: clusterId(input.company_id),
    company_id: input.company_id,
    mode: input.mode,
    window: {
      from: addDays(input.today, -rules.corroboration_window_days),
      to: input.today,
    },
    top_tier: topTier,
    // Any tier 1 in the cluster means we ask the user to verify with the
    // counterparty before acting -- we report records, they hold the relationship.
    verify_with_counterparty: surfaced.some((s) => s.tier === 1),
    signals: ordered.map((s) => s.signal_id),
    deals: input.exposure.deals,
    exposure: {
      top_weight: input.exposure.top_weight,
      annual_value_usd: input.exposure.annual_value_usd,
    },
    coverage: input.coverage ?? EMPTY_COVERAGE,
    fingerprint: fingerprint(ordered),
  });

  return { cluster, surfaced: [...surfaced], promoted_by_pattern: promoted };
};
