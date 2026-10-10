import { randomUUID } from 'node:crypto';
import type { Deal } from '@donna/contracts';

/**
 * Entity resolution: the hardest component, and the one everything else depends
 * on. A wrong match here makes every later step confidently wrong -- we would
 * monitor the wrong company and report its changes against someone else's
 * agreement. So the bar is deliberately high and the failure mode is deliberately
 * visible: below the confidence threshold the deal is parked for a human with the
 * candidates attached, never auto-resolved.
 */

export interface RegistryCandidate {
  canonical_name: string;
  registry_id: string;
  jurisdiction: string;
  status?: string;
  registered_address?: string;
  officers?: Array<{ name: string; role?: string }>;
  source_url?: string;
}

export interface ResolutionJudgement {
  /** registry_id of the chosen candidate, or null for no_match. */
  registry_id: string | null;
  /** 0..1. Note: company.resolution.confidence is a FLOAT, unlike signal.confidence. */
  confidence: number;
  /** Shown on the company page so a user can see WHY we think this is their company. */
  reason: string;
}

export interface Judge {
  resolve(input: {
    deal: Pick<Deal, 'counterparty_name' | 'country'>;
    candidates: RegistryCandidate[];
    domains: string[];
    aliases: string[];
  }): Promise<ResolutionJudgement>;
}

export interface ResolutionOutcome {
  status: 'resolved' | 'needs_review';
  company_id: string;
  canonical_name: string;
  jurisdiction: string;
  registry_id: string;
  aliases: string[];
  domains: string[];
  officers: Array<Record<string, unknown>>;
  /** Stored and SHOWN, but not collected -- see the note below. */
  related_entities: Array<Record<string, unknown>>;
  resolution: {
    confidence: number | null;
    reason: string;
    resolved_by: string;
    candidates_seen: Array<Record<string, unknown>>;
  };
}

/** Below this, a human decides. */
export const CONFIDENCE_THRESHOLD = 0.85;

export const AUTO_RESOLVER = 'auto_resolver';

/**
 * Turn candidates plus a judgement into an outcome.
 *
 * Two product rules are enforced here rather than left to the caller:
 *
 * 1. **Never auto-resolve a low-confidence match.** Below the threshold, or on
 *    no_match, the deal goes to needs_review WITH the candidates, so the review
 *    list can show a person what we considered.
 *
 * 2. **Resolve all the way, or carry no state worth losing.** Track C's
 *    findCandidates does a whole-subdocument $set on `resolution` and forces
 *    status back to needs_review. A deal at status 'resolved' is protected
 *    because findCandidates 409s on it -- but anything we park at needs_review
 *    can be overwritten the moment an analyst clicks "find stored candidates".
 *    So a parked deal keeps nothing we would mind losing.
 */
export function outcomeFor(
  deal: Pick<Deal, 'counterparty_name' | 'country'>,
  candidates: RegistryCandidate[],
  judgement: ResolutionJudgement,
  domains: string[],
): ResolutionOutcome {
  const chosen = judgement.registry_id
    ? candidates.find((c) => c.registry_id === judgement.registry_id)
    : undefined;

  const confident = Boolean(chosen) && judgement.confidence >= CONFIDENCE_THRESHOLD;
  const candidates_seen = candidates.map((c) => ({
    canonical_name: c.canonical_name,
    registry_id: c.registry_id,
    jurisdiction: c.jurisdiction,
    ...(c.status ? { status: c.status } : {}),
    ...(c.source_url ? { source_url: c.source_url } : {}),
  }));

  if (!confident || !chosen) {
    return {
      status: 'needs_review',
      company_id: randomUUID(),
      canonical_name: deal.counterparty_name,
      jurisdiction: deal.country,
      registry_id: '',
      aliases: [deal.counterparty_name],
      domains,
      officers: [],
      related_entities: [],
      resolution: {
        confidence: judgement.registry_id ? judgement.confidence : null,
        reason: judgement.registry_id
          ? `Best candidate scored ${judgement.confidence.toFixed(2)}, below the ${CONFIDENCE_THRESHOLD} threshold for an automatic match. ${judgement.reason}`
          : `No candidate matched. ${judgement.reason}`,
        resolved_by: AUTO_RESOLVER,
        candidates_seen,
      },
    };
  }

  return {
    status: 'resolved',
    company_id: randomUUID(),
    canonical_name: chosen.canonical_name,
    jurisdiction: chosen.jurisdiction,
    registry_id: chosen.registry_id,
    // The name as the user typed it is kept as an alias, never as the canonical
    // name: Track C 409s on a canonical_name change, which would break the
    // user's next "Add company".
    aliases: dedupe([deal.counterparty_name, chosen.canonical_name]),
    domains,
    officers: (chosen.officers ?? []).map((o) => ({ ...o })),
    // Related entities (parent, subsidiaries) are stored and shown but NOT
    // collected: collecting them multiplies credit spend by the size of the
    // group. So a change at the parent does not surface yet, and the product
    // says so rather than implying coverage it does not have.
    related_entities: [],
    resolution: {
      confidence: judgement.confidence,
      reason: judgement.reason,
      resolved_by: AUTO_RESOLVER,
      candidates_seen,
    },
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}
