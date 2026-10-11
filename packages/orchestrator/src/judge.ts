import type { Judge, RegistryCandidate, ResolutionJudgement } from './resolution.js';

/**
 * The Claude call behind entity resolution.
 *
 * Model choice is empirical, not a preference. Haiku 4.5 with thinking
 * DISABLED: this is a short structured decision, and on the narrator workload
 * Haiku 5.5 with its default thinking burned the whole token budget reasoning
 * and returned nothing. Overridable per deployment, so escalating one hard
 * company is config rather than a code change.
 */
export const DEFAULT_JUDGE_MODEL = 'claude-haiku-4-5-20251001';

export const judgeModel = (env: NodeJS.ProcessEnv = process.env): string =>
  env.DONNA_JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL;

const SYSTEM = `You match a counterparty named on a commercial agreement to a company registry record.

You are given the name as the user typed it, its country, and candidate registry records.

Return ONLY JSON: {"registry_id": string|null, "confidence": number, "reason": string}

- registry_id: the registry_id of the ONE candidate that is the same legal entity, or null for no match.
- confidence: 0 to 1. Be honest and be conservative. A wrong match makes every later step confidently wrong: the system would monitor a different company and report its changes against this agreement. Prefer null over a guess.
- reason: one or two sentences a finance person can check, naming the specific evidence you used (legal name, suffix, jurisdiction, registered address, officers). This is shown to the user, so say what actually convinced you.

A shared word in a name is not a match. A different jurisdiction is not a match. A plausible-but-unverified name is not a match; that is what null is for.`;

export interface JudgeClient {
  complete(input: { system: string; user: string; model: string }): Promise<string>;
}

/** Minimal Messages API client. Kept tiny and injectable so tests need no key. */
export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): JudgeClient | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    async complete({ system, user, model }) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 700,
          thinking: { type: 'disabled' },
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (!res.ok) throw new Error(`judge http ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      return (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    },
  };
}

/**
 * No client means no judgement -- and no judgement means needs_review, which is
 * the path Track C's review list already renders. The product degrades to
 * asking a human, never to a guess.
 */
export const abstain: ResolutionJudgement = {
  registry_id: null,
  confidence: 0,
  reason: 'Automated matching was unavailable, so no candidate was selected. Pick the correct legal entity, or record a new one.',
};

export function makeJudge(client: JudgeClient | null, model = judgeModel()): Judge {
  return {
    async resolve({ deal, candidates, domains, aliases }) {
      if (!client || candidates.length === 0) return abstain;
      const user = JSON.stringify({
        counterparty_name: deal.counterparty_name,
        country: deal.country,
        observed_domains: domains,
        observed_aliases: aliases,
        candidates: candidates.map((c) => ({
          registry_id: c.registry_id,
          canonical_name: c.canonical_name,
          jurisdiction: c.jurisdiction,
          status: c.status,
          registered_address: c.registered_address,
          officers: (c.officers ?? []).slice(0, 8),
        })),
      }, null, 1);

      let text: string;
      try {
        text = await client.complete({ system: SYSTEM, user, model });
      } catch {
        // An API failure must not auto-resolve and must not throw into the
        // loop. It becomes a review item like any other uncertainty.
        return abstain;
      }
      return parseJudgement(text, candidates);
    },
  };
}

/** Tolerant parse: a model that wraps JSON in prose should not cost us a deal. */
export function parseJudgement(
  text: string,
  candidates: RegistryCandidate[],
): ResolutionJudgement {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return abstain;
    try { raw = JSON.parse(m[0]); } catch { return abstain; }
  }

  const obj = (raw ?? {}) as Record<string, unknown>;
  const id = typeof obj.registry_id === 'string' ? obj.registry_id : null;
  const confidence = typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
    ? Math.min(1, Math.max(0, obj.confidence))
    : 0;
  const reason = typeof obj.reason === 'string' && obj.reason.trim().length > 0
    ? obj.reason.trim()
    : 'No reason given.';

  // A registry_id that is not among the candidates is a hallucination, not a
  // match. Treat it as no match rather than resolving to a record we never saw.
  if (id !== null && !candidates.some((c) => c.registry_id === id)) {
    return {
      registry_id: null,
      confidence: 0,
      reason: `The proposed registration ${id} was not among the candidates considered, so no match was recorded.`,
    };
  }

  return { registry_id: id, confidence, reason };
}
