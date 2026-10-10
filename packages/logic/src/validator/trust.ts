import {
  TRUST_CONFIDENCE, TRUST_CAN_ESCALATE_ALONE,
  type Confidence, type Evidence, type SignalStatus, type Tier, type Trust,
} from '@donna/contracts';
import { loadRules, type Rules } from './rules.js';

/**
 * Step 2 -- what the sources behind a signal are allowed to claim.
 *
 * The one rule that matters most here: A REPORTED SOURCE ALONE MUST NOT REACH
 * TIER 1 OR 2. A single news story is a lead, not a finding -- we would be
 * telling a finance person to pick up the phone about something no registry,
 * court or regulator has recorded. Two independent outlets, or one primary
 * record, and it is a finding. Until then it is demoted to tier 3, where it
 * can only surface as part of a pattern, and labelled reported-and-unconfirmed.
 *
 * Inferred sources (jobs, domain) never promote a tier by themselves for the
 * same reason, one step weaker: a careers page shrinking is not evidence of
 * why it shrank.
 */

export const TRUST_RANK: Record<Trust, number> = { inferred: 0, reported: 1, primary: 2 };
const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export const confidenceRank = (c: Confidence): number => CONFIDENCE_RANK[c];

export const hasPrimary = (evidence: readonly Evidence[]): boolean =>
  evidence.some((e) => TRUST_CAN_ESCALATE_ALONE[e.trust]);

/**
 * How many independent reported outlets stand behind this. Independence is by
 * (source, url): two stories on the same page of the same outlet are one
 * outlet, a news story plus an executive-moves listing are two.
 */
export const independentReportedOutlets = (evidence: readonly Evidence[]): number =>
  new Set(
    evidence.filter((e) => e.trust === 'reported').map((e) => `${e.source}|${e.url}`),
  ).size;

export const bestTrust = (evidence: readonly Evidence[]): Trust =>
  evidence.reduce<Trust>(
    (best, e) => (TRUST_RANK[e.trust] > TRUST_RANK[best] ? e.trust : best),
    'inferred',
  );

/** Can this evidence set stand behind an alerting tier (1 or 2)? */
export const canStandAlone = (evidence: readonly Evidence[], rules: Rules = loadRules()): boolean =>
  hasPrimary(evidence)
  || independentReportedOutlets(evidence) >= rules.thresholds.reported_min_independent_outlets;

/**
 * The tier a signal is actually allowed to hold, given the rule's fixed tier
 * and the trust of its evidence. Tiers 0 and 3 are never gated -- they do not
 * alert on their own, so there is nothing to protect against.
 */
export const resolveTier = (
  baseTier: Tier,
  evidence: readonly Evidence[],
  rules: Rules = loadRules(),
): Tier => {
  if (baseTier === 0 || baseTier === 3) return baseTier;
  return canStandAlone(evidence, rules) ? baseTier : 3;
};

export const resolveConfidence = (evidence: readonly Evidence[]): Confidence => {
  const base = TRUST_CONFIDENCE[bestTrust(evidence)];
  // Corroboration across distinct sources, where one of them is primary,
  // is the only thing that lifts confidence above its source's own ceiling.
  const distinctSources = new Set(evidence.map((e) => e.source)).size;
  if (base === 'medium' && distinctSources > 1 && hasPrimary(evidence)) return 'high';
  return base;
};

export const resolveStatus = (
  evidence: readonly Evidence[],
  opts: { baseline?: boolean } = {},
): SignalStatus => {
  if (opts.baseline) return 'baseline';
  if (hasPrimary(evidence)) return 'confirmed';
  if (evidence.some((e) => e.trust === 'reported')) return 'reported';
  return 'inferred';
};
