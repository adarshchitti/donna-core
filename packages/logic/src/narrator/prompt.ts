import type { Cluster } from '@donna/contracts';
import { NARRATOR_MAX_TOKENS, THINKING_DISABLED, narratorModel, type NarratorMessageRequest } from './model.js';
import type { NarratorInput, NarratorSignalView } from './types.js';

/**
 * The four profile sections, in order. Fixed titles because the profile page is
 * read as a form: the same four questions about every company, so a missing
 * answer is visible as a gap rather than as a shorter page.
 */
export const PROFILE_SECTION_TITLES = [
  'How this company has behaved',
  'Who runs it, and how often that changes',
  'How it treats counterparties',
  'What to ask before signing',
] as const;

/**
 * The hard constraints, stated to the model. Every one of them is ALSO enforced
 * by postProcess, which is the point: the prompt is how we usually get it right
 * and the post-processor is why we can promise it. If you change a rule here,
 * change it there in the same commit.
 */
export const SYSTEM_PROMPT = `You write short briefings about counterparty records for a finance reader. You are given validated signals, never raw pages. Return JSON only.

HARD RULES

1. CITE EVERYTHING. Every sentence that states a fact must carry the id of the signal it rests on, inline, in square brackets, at the end of that sentence: "The registry filing records a transfer of majority ownership on 9 October 2026 [sig-001]." A sentence about a linked agreement cites the deal id the same way [dl-acme-1]. Several ids in one bracket, separated by commas, are fine: [sig-001, dl-acme-1]. A sentence with no citation will be deleted before anyone reads it, so an uncited sentence is a wasted sentence. The only two kinds of sentence that need no citation are (a) a statement of absence or limitation ("no change observed", "payment behaviour is not covered") and (b) a sentence that OPENS with something to ask ("Worth asking about ...", "Consider ...", "Confirm whether ...").

2. NEVER REASSURE. The words "healthy", "good standing", "safe" and "low risk" are forbidden. You do not certify a company. Where nothing was found, say "no change observed" - that is a statement about what we checked, not about the company.

3. NOTHING IS ADVICE. "Worth asking about" and "consider" are allowed. "You should" and "you must" are not. Do not tell the reader what to do.

4. NEVER SAY A TERM WAS BREACHED. The word "breach" in any form is forbidden. A signal "touches a term you signed". Whether that is a breach is a lawyer's determination, not yours.

5. OUTPUT IS JSON, nothing before it and nothing after it, with exactly these keys:
{
  "headline": "one sentence: what moved, and on which deal",
  "what_changed": [{"text": "one line for ONE signal", "signal_id": "the id of that signal"}],
  "why_it_matters": "two or three sentences tied to the deal fields given to you: value, share of revenue, notice window, deal class",
  "verify": "the specific thing to ask the counterparty, or null",
  "confidence_note": "what is reported versus what is confirmed",
  "sections": [{"title": "...", "text": "...", "gap": true}]
}

FIELD RULES
- what_changed: exactly one line per signal you were given, each carrying that signal's id in its signal_id field. Do not invent an id. Do not merge two signals into one line.
- why_it_matters: tie it to the deal fields. Cite signal ids for the observations and deal ids for the agreement facts. A sentence that describes something observed must carry a signal id, not only a deal id.
- verify: a string ONLY when verify_with_counterparty is true in the input; otherwise exactly null.
- confidence_note: required whenever any signal confidence is "medium" or "low". Say plainly which observations are reported rather than confirmed.
- sections: ONLY when mode is "profile", and then exactly these four titles in this order: ${PROFILE_SECTION_TITLES.map((t) => `"${t}"`).join(', ')}. A section that states an absence rather than an observation must set "gap": true.
- Do not return a "coverage" field. Coverage is copied from the input and is not yours to write.`;

/** What the model is shown about one signal. No urls, no snapshot ids, no pages. */
interface PromptSignal {
  signal_id: string;
  type: string;
  title: string;
  tier: number;
  confidence: string;
  status: string;
  first_seen: string;
  summary_fact: string;
  touches_terms: readonly string[];
  evidence_excerpts: readonly string[];
}

const promptSignal = (s: NarratorSignalView): PromptSignal => ({
  signal_id: s.signal_id,
  type: s.type,
  title: s.title,
  tier: s.tier,
  confidence: s.confidence,
  status: s.status,
  first_seen: s.first_seen,
  summary_fact: s.summary_fact,
  touches_terms: s.touches_terms,
  evidence_excerpts: s.excerpts,
});

export interface PromptPayload {
  mode: Cluster['mode'];
  company_id: string;
  window: Cluster['window'];
  verify_with_counterparty: boolean;
  signals: PromptSignal[];
  deals: Cluster['deals'];
  exposure: Cluster['exposure'];
  coverage_for_context: {
    checked: readonly string[];
    failed: readonly string[];
    not_covered: readonly string[];
  };
}

/**
 * The payload. Built from `NarratorSignalView`s only -- the type signature is
 * the enforcement that the narrator never sees a raw page, because there is no
 * `Signal`, no `Evidence` and no `raw_excerpt` anywhere in reach of this
 * function.
 *
 * Coverage is shown read-only, named `coverage_for_context`, so the model can
 * say "court records were not reachable" without being able to mistake it for a
 * field it is meant to return.
 */
export const buildPromptPayload = (input: NarratorInput): PromptPayload => ({
  mode: input.cluster.mode,
  company_id: input.cluster.company_id,
  window: input.cluster.window,
  verify_with_counterparty: input.cluster.verify_with_counterparty,
  signals: input.signals.map(promptSignal),
  deals: input.cluster.deals,
  exposure: input.cluster.exposure,
  coverage_for_context: {
    checked: input.cluster.coverage.checked,
    failed: input.cluster.coverage.failed,
    not_covered: input.cluster.coverage.not_covered,
  },
});

export const buildNarratorRequest = (
  input: NarratorInput,
  env: Record<string, string | undefined> = process.env,
): NarratorMessageRequest => ({
  model: narratorModel(env),
  max_tokens: NARRATOR_MAX_TOKENS,
  thinking: THINKING_DISABLED,
  system: SYSTEM_PROMPT,
  messages: [
    {
      role: 'user',
      content: JSON.stringify(buildPromptPayload(input), null, 1),
    },
  ],
});
