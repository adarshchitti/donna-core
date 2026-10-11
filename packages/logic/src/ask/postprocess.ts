import type { CollectorRun, Deal } from '@donna/contracts';
import { findForbidden } from '../narrator/forbidden.js';
import {
  isFactualSentence,
  splitSentences,
  stripMarkers,
} from '../narrator/sentences.js';
import type { NarratorSignalView } from '../narrator/types.js';
import type { AskLine, AskReport } from './types.js';

/**
 * THE ASK GATE.
 *
 * The same mechanism as the narrator's postProcess, on an answer instead of a
 * briefing -- and reusing its machinery (`splitSentences`, `isFactualSentence`,
 * `stripMarkers`, `findForbidden`) rather than a copy, because "factual" and
 * "forbidden" mean exactly one thing in this codebase.
 *
 * The model's draft is plain text with inline [record-id] markers. For each
 * sentence the markers are resolved against the CANDIDATE records -- not the
 * input, the retrieval result -- so a citation can only ever point at a record
 * the question legitimately reached. An id the model invented, or one naming a
 * record outside the answer's scope, resolves to nothing.
 *
 *   STRIP  -- a factual sentence with no resolving citation, or a citation id
 *             that resolves to nothing. The rest of the answer still publishes.
 *   REJECT -- forbidden language, or every sentence stripped. The caller falls
 *             back to the code-built answer.
 */

/** The coverage pseudo-ids minted per input position (`cov-1`, `cov-2`, ...). */
export const coverageId = (index: number): string => `cov-${index + 1}`;

export interface GateContext {
  signals: readonly NarratorSignalView[];
  deals: readonly Deal[];
  runs: readonly CollectorRun[];
  /** How many coverage entries were offered; `cov-N` resolves for N <= this. */
  coverage_count: number;
  /**
   * A coverage-intent answer may legitimately produce no observation lines --
   * the coverage block appended by the caller IS the answer. Other intents
   * treat an emptied draft as a reject, because publishing nothing is worse
   * than falling back.
   */
  allow_empty?: boolean;
}

export interface GateResult {
  ok: boolean;
  lines: AskLine[];
  report: AskReport;
}

const emptyReport = (): AskReport => ({
  stripped_sentences: [],
  stripped_citations: [],
  violations: [],
});

/**
 * Event verbs. A `baseline` signal is a starting record, not something that
 * happened: a sentence whose ONLY backing is baseline records must not read as
 * an event. "registered" and "file" are deliberately absent -- baseline
 * summary_facts legitimately say "registered entity" and deterministic lines
 * say "on file".
 */
const EVENT_RE =
  /\b(filed|changed|transferred|departed|appointed|announced|defaulted|collapsed|sued|acquired|merged|resigned|dismissed|terminated|declared|entered\s+into|became|happened|occurred|emerged|launched|issued)\b/i;

export const checkAnswer = (text: string, ctx: GateContext): GateResult => {
  const report = emptyReport();

  const signalById = new Map(ctx.signals.map((s) => [s.signal_id, s]));
  const dealIds = new Set(ctx.deals.map((d) => d.deal_id));
  const runIds = new Set(ctx.runs.map((r) => r.run_id));

  // --- forbidden language: REJECT, never edit -------------------------------
  const hits = findForbidden(text);
  if (hits.length > 0) {
    report.violations.push({
      rule: 'forbidden-language',
      detail: hits.map((h) => `${h.rule}/"${h.match}"`).join(', '),
    });
    return { ok: false, lines: [], report };
  }

  const lines: AskLine[] = [];

  for (const sentence of splitSentences(text)) {
    const signals: string[] = [];
    const other: string[] = [];
    for (const id of sentence.markers) {
      if (signalById.has(id)) signals.push(id);
      else if (dealIds.has(id) || runIds.has(id)) other.push(id);
      else if (/^cov-\d+$/.test(id) && Number(id.slice(4)) <= ctx.coverage_count) other.push(id);
      else report.stripped_citations.push({ id });
    }
    const backed = signals.length > 0 || other.length > 0;
    const factual = isFactualSentence(sentence.raw);

    if (factual && !backed) {
      report.stripped_sentences.push({
        sentence: stripMarkers(sentence.raw),
        reason: 'factual sentence with no citation that resolves',
      });
      continue;
    }

    // A sentence resting ONLY on baseline records must not read as an event.
    if (
      factual &&
      signals.length > 0 &&
      other.length === 0 &&
      signals.every((id) => signalById.get(id)?.status === 'baseline') &&
      EVENT_RE.test(stripMarkers(sentence.raw))
    ) {
      report.stripped_sentences.push({
        sentence: stripMarkers(sentence.raw),
        reason: 'a baseline record cannot be presented as something that happened',
      });
      continue;
    }

    lines.push({
      text: stripMarkers(sentence.raw),
      citations: [...new Set([...signals, ...other])],
      kind: factual ? 'observation' : 'absence',
    });
  }

  if (lines.length === 0 && ctx.allow_empty !== true) {
    report.violations.push({
      rule: 'answer-empty',
      detail: 'every sentence was stripped or the draft was empty',
    });
  }

  return { ok: report.violations.length === 0, lines, report };
};
