import { findForbidden } from '../../narrator/forbidden.js';
import { isFactualSentence, splitSentences } from '../../narrator/sentences.js';
import { coverageId } from '../postprocess.js';
import type { AskAnswer, AskInput, AskKind } from '../types.js';

/**
 * The eval assertions. `evaluate` returns a list of human-readable failures;
 * empty means the case passed. The same expectations run against the
 * deterministic answer and the gated model answer, so a divergence between
 * them is the finding, not something to tune away.
 *
 * Two checks are not optional and run on every case:
 *   - no forbidden word anywhere in the rendered answer
 *   - every factual sentence sits on a line carrying a citation that resolves
 *     to a supplied record
 */
export interface AskExpect {
  /** The answer kind, or acceptable kinds. */
  kind?: AskKind | AskKind[];
  /** Substrings or patterns that must appear in the rendered text (case-insensitive). */
  contains?: readonly (string | RegExp)[];
  /** Substrings or patterns that must NOT appear. */
  not_contains?: readonly (string | RegExp)[];
  /** Every citation must be one of these ids. */
  only_cites?: readonly string[];
  /** Each of these ids must be cited at least once. */
  cites?: readonly string[];
  /** None of these ids may be cited. */
  never_cites?: readonly string[];
  /** At least this many observation lines. */
  min_observations?: number;
  /**
   * No line backed ONLY by baseline records may read as an event. (The gate
   * strips these in model output; this checks the property end-to-end.)
   */
  baseline_not_event?: boolean;
}

export interface AskEvalCase {
  name: string;
  question: string;
  input: Omit<AskInput, 'question'>;
  expect: AskExpect;
}

/** Event verbs, mirrored from the gate -- the eval checks the same property. */
const EVENT_RE =
  /\b(filed|changed|transferred|departed|appointed|announced|defaulted|collapsed|sued|acquired|merged|resigned|dismissed|terminated|declared|entered\s+into|became|happened|occurred|emerged|launched|issued)\b/i;

const matches = (text: string, pat: string | RegExp): boolean =>
  typeof pat === 'string'
    ? text.toLowerCase().includes(pat.toLowerCase())
    : pat.test(text);

export const suppliedIds = (input: Omit<AskInput, 'question'>): Set<string> =>
  new Set([
    ...input.signals.map((s) => s.signal_id),
    ...input.deals.map((d) => d.deal_id),
    ...input.runs.map((r) => r.run_id),
    ...input.coverage.map((_, i) => coverageId(i)),
  ]);

export const evaluate = (answer: AskAnswer, caze: AskEvalCase): string[] => {
  const failures: string[] = [];
  const { expect } = caze;
  const supplied = suppliedIds(caze.input);
  const baselineIds = new Set(
    caze.input.signals.filter((s) => s.status === 'baseline').map((s) => s.signal_id),
  );

  // --- forbidden language: never, on either path ---------------------------
  for (const hit of findForbidden(answer.text)) {
    failures.push(`forbidden ${hit.rule} word in answer: "${hit.match}"`);
  }

  // --- grounding: every factual sentence sits on a cited line --------------
  for (const line of answer.lines) {
    for (const sentence of splitSentences(line.text)) {
      if (isFactualSentence(sentence.raw) && line.citations.length === 0) {
        failures.push(`uncited factual sentence: "${sentence.raw.slice(0, 80)}"`);
      }
    }
    for (const id of line.citations) {
      if (!supplied.has(id)) {
        failures.push(`citation "${id}" resolves to no supplied record`);
      }
    }
  }

  if (expect.kind !== undefined) {
    const kinds = Array.isArray(expect.kind) ? expect.kind : [expect.kind];
    if (!kinds.includes(answer.kind)) {
      failures.push(`kind is "${answer.kind}", expected ${kinds.join(' | ')}`);
    }
  }

  for (const pat of expect.contains ?? []) {
    if (!matches(answer.text, pat)) {
      failures.push(`answer does not contain ${String(pat)}`);
    }
  }
  for (const pat of expect.not_contains ?? []) {
    if (matches(answer.text, pat)) {
      failures.push(`answer contains ${String(pat)}`);
    }
  }

  const cited = new Set(answer.lines.flatMap((l) => l.citations));
  for (const id of expect.cites ?? []) {
    if (!cited.has(id)) failures.push(`expected citation "${id}" was not used`);
  }
  for (const id of expect.never_cites ?? []) {
    if (cited.has(id)) failures.push(`forbidden citation "${id}" was used`);
  }
  if (expect.only_cites !== undefined) {
    const allowed = new Set(expect.only_cites);
    for (const id of cited) {
      if (!allowed.has(id)) failures.push(`unexpected citation "${id}"`);
    }
  }

  const observations = answer.lines.filter((l) => l.kind === 'observation');
  if (expect.min_observations !== undefined && observations.length < expect.min_observations) {
    failures.push(
      `${observations.length} observation line(s), expected at least ${expect.min_observations}`,
    );
  }

  if (expect.baseline_not_event === true) {
    for (const line of answer.lines) {
      const onlyBaseline =
        line.citations.length > 0 && line.citations.every((id) => baselineIds.has(id));
      if (onlyBaseline && EVENT_RE.test(line.text)) {
        failures.push(`baseline record presented as an event: "${line.text.slice(0, 80)}"`);
      }
    }
  }

  return failures;
};
