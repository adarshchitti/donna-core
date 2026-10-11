import { neutraliseLine } from '../narrator/forbidden.js';
import { isFactualSentence } from '../narrator/sentences.js';
import type { NarratorSignalView } from '../narrator/types.js';
import type { Deal } from '@donna/contracts';
import { coverageId } from './postprocess.js';
import { questionTopic, sourceNames } from './retrieve.js';
import type {
  AskCandidates,
  AskInput,
  AskIntent,
  AskKind,
  AskLine,
} from './types.js';

/**
 * THE CODE-BUILT ANSWER.
 *
 * The deterministic path is not a degraded version of the model path; it is the
 * path that runs when there is no client at all, and the floor the model path
 * falls back to. Every line here is either an absence/refusal sentence (which
 * needs no citation), a coverage line (copied from stored coverage, cited by
 * its `cov-N` id), or an observation line carrying the record's own
 * summary_fact and id. Nothing here is phrased by a model, so nothing here can
 * invent.
 *
 * `neutraliseLine` guards the one dangerous channel: record text is attacker-
 * influenced (it comes from fetched pages), and a fetched page can contain the
 * word "breach". A line that would carry forbidden language is replaced with
 * the neutral line rather than shipped -- the fallback cannot reject itself.
 */

const absence = (text: string): AskLine => ({ text, citations: [], kind: 'absence' });

/** Refusal framing, phrased to sit inside the citation-exempt categories. */
export const REFUSAL_LINES: readonly string[] = [
  'This system reports what is recorded; it is not an assessment of the counterparty.',
  'Whether to renew or sign is not covered by these records.',
];

/** True when an already-produced line carries refusal framing of its own. */
const hasRefusalFraming = (lines: readonly AskLine[]): boolean =>
  lines.some((l) =>
    /not an assessment|not a determination|does not advise|not covered|is not evidence/i.test(l.text),
  );

const money = (usd: number): string => {
  const n = Math.abs(usd);
  if (n >= 1_000_000) return `$${(usd / 1_000_000).toFixed(usd % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${Math.round(usd / 1_000)}K`;
  return `$${usd}`;
};

const signalLine = (s: NarratorSignalView): AskLine => ({
  text:
    s.status === 'baseline'
      ? `Baseline on file: ${neutraliseLine(s.summary_fact)}`
      : neutraliseLine(s.summary_fact),
  citations: [s.signal_id],
  kind: 'observation',
});

const touchedTermLine = (s: NarratorSignalView): AskLine => ({
  text: `${neutraliseLine(s.summary_fact).replace(/[.\s]+$/, '')}. It touches a term that was signed: ${s.touches_terms
    .map((t) => `"${t}"`)
    .join(', ')}.`,
  citations: [s.signal_id],
  kind: 'observation',
});

const dealLine = (d: Deal): AskLine => {
  const parts = [
    `class "${d.deal_class}"`,
    `${money(d.annual_value_usd)} annual value`,
    `stated end date ${d.end_date}`,
    ...(d.notice_days !== undefined ? [`${d.notice_days} days' notice`] : []),
    ...(d.watch_terms !== undefined && d.watch_terms !== ''
      ? [`watched terms: ${d.watch_terms}`]
      : []),
  ];
  return {
    text: `Linked agreement on record: ${neutraliseLine(`${d.counterparty_name}, ${parts.join(', ')}`)}`,
    citations: [d.deal_id],
    kind: 'observation',
  };
};

/**
 * Coverage lines. Coverage is a stored record here -- each input entry is
 * addressable as `cov-N`, so the line can carry a citation like any other
 * grounded line rather than being exempt by courtesy.
 */
export const coverageLines = (candidates: AskCandidates): AskLine[] =>
  candidates.coverage.map((cov, i) => {
    const checked = sourceNames(cov.checked);
    const failed = sourceNames(cov.failed);
    const parts = [
      `Checked: ${checked.length > 0 ? checked.join(', ') : 'none recorded'}.`,
      ...(failed.length > 0 ? [`Not reachable: ${failed.join(', ')}.`] : []),
      ...(cov.not_covered.length > 0 ? [`Not covered: ${cov.not_covered.join(', ')}.`] : []),
    ];
    return {
      text: parts.join(' '),
      citations: [coverageId(i)],
      kind: 'coverage' as const,
    };
  });

/** Failed collector runs are records too: a failed check is stated, cited. */
const failedRunLines = (candidates: AskCandidates): AskLine[] =>
  candidates.runs
    .filter((r) => r.status === 'failed')
    .map((r) => ({
      text: `A ${r.source} collection run is recorded as failed.`,
      citations: [r.run_id],
      kind: 'observation' as const,
    }));

const NOT_PROOF =
  'A source that returned nothing is not evidence that nothing exists.';

const notObservedLines = (input: AskInput, candidates: AskCandidates): AskLine[] => [
  absence(`${questionTopic(input.question)} is not observed in what has been checked.`),
  ...coverageLines(candidates),
  absence(NOT_PROOF),
];

export interface DeterministicResult {
  kind: AskKind;
  lines: AskLine[];
}

export const buildDeterministic = (
  input: AskInput,
  intent: AskIntent,
  candidates: AskCandidates,
): DeterministicResult => {
  switch (intent) {
    case 'verdict': {
      const refusals = REFUSAL_LINES.map(absence);
      const observations = [
        ...candidates.signals.map(signalLine),
        ...candidates.deals.map(dealLine),
      ];
      return {
        kind: 'verdict_refusal',
        lines:
          observations.length > 0
            ? [...refusals, ...observations]
            : [...refusals, ...notObservedLines(input, candidates)],
      };
    }
    case 'coverage': {
      const cov = coverageLines(candidates);
      const failed = failedRunLines(candidates);
      if (cov.length === 0 && failed.length === 0) {
        return { kind: 'not_observed', lines: notObservedLines(input, candidates) };
      }
      return { kind: 'coverage', lines: [...cov, ...failed, absence(NOT_PROOF)] };
    }
    case 'watched_terms': {
      const lines = [
        ...candidates.signals
          .filter((s) => s.touches_terms.length > 0)
          .map(touchedTermLine),
        ...candidates.deals.filter((d) => (d.watch_terms ?? '') !== '').map(dealLine),
      ];
      if (lines.length === 0) {
        return {
          kind: 'watched_terms',
          lines: [
            absence('Nothing observed touches a watched term in what has been checked.'),
            ...coverageLines(candidates),
          ],
        };
      }
      return { kind: 'watched_terms', lines };
    }
    case 'records': {
      const lines = [
        ...candidates.signals.map(signalLine),
        ...candidates.deals.map(dealLine),
      ];
      if (lines.length === 0) {
        return { kind: 'not_observed', lines: notObservedLines(input, candidates) };
      }
      return { kind: 'observations', lines };
    }
  }
};

/**
 * The refusal prefix for the MODEL path on verdict questions. Appended by the
 * caller only when the model's kept lines carry no refusal framing of their
 * own -- the property is guaranteed by code, the phrasing is the model's.
 */
export const refusalPrefixLines = (lines: readonly AskLine[]): AskLine[] =>
  hasRefusalFraming(lines) ? [] : REFUSAL_LINES.map(absence);

/**
 * The watched-terms suffix for the MODEL path. The eval-facing phrasing --
 * "touches a term that was signed" -- is guaranteed: if the model reported the
 * signals without it, code appends one line stating it (citing the touched
 * records) rather than trusting phrasing to luck.
 */
export const watchedTermSuffixLines = (
  lines: readonly AskLine[],
  candidates: AskCandidates,
): AskLine[] => {
  if (lines.some((l) => /touch(?:es)?\s+a?\s*terms?|watched terms?/i.test(l.text))) return [];
  const touched = candidates.signals.filter((s) => s.touches_terms.length > 0);
  if (touched.length === 0) return [];
  const terms = [...new Set(touched.flatMap((s) => s.touches_terms))]
    .map((t) => `"${t}"`)
    .join(', ');
  return [
    {
      text:
        touched.length === 1
          ? `The cited record touches a term that was signed: ${terms}.`
          : `The cited records touch terms that were signed: ${terms}.`,
      citations: touched.map((s) => s.signal_id),
      kind: 'observation' as const,
    },
  ];
};

/** Sanity check used in tests: deterministic absence lines really are exempt. */
export const absenceLinesAreExempt = (): boolean =>
  [...REFUSAL_LINES, NOT_PROOF].every((t) => !isFactualSentence(t));
