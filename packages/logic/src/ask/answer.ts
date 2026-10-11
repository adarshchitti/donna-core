import type { NarratorMessageResponse } from '../narrator/model.js';
import { extractJson } from '../narrator/narrate.js';
import {
  buildDeterministic,
  refusalPrefixLines,
  watchedTermSuffixLines,
} from './deterministic.js';
import { askDraftSchema } from './types.js';
import { checkAnswer } from './postprocess.js';
import { buildAskRequest } from './prompt.js';
import {
  classifyIntent,
  detectCompanyScope,
  retrieveCandidates,
} from './retrieve.js';
import type { AskClient } from './model.js';
import type {
  AskAnswer,
  AskCandidates,
  AskInput,
  AskIntent,
  AskKind,
  AskLine,
  AskReport,
} from './types.js';

/**
 * One Claude call per question, then the gate.
 *
 * Degradation ladder, mirroring the narrator's:
 *   no client (no API key)        -> deterministic, NO network call attempted
 *   coverage-intent question      -> deterministic, always (the answer IS a
 *                                    verbatim coverage record; a model adds
 *                                    only risk, the same reason the narrator
 *                                    never lets the model write coverage)
 *   no candidate records          -> deterministic "not observed" -- with no
 *                                    records to cite, a model could only
 *                                    refuse or invent
 *   transport/JSON/schema failure -> retry once, then deterministic
 *   gate rejection                -> retry once, then deterministic
 */

export const ASK_ATTEMPTS = 2;

export interface AskDeps {
  client: AskClient | null;
  env?: Record<string, string | undefined>;
  onReport?: (report: AskReport, stage: 'answer' | 'deterministic') => void;
}

const responseText = (content: NarratorMessageResponse['content']): string => {
  const text = content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  if (text.trim() === '') throw new Error('response contained no text block');
  return text;
};

const renderText = (lines: readonly AskLine[]): string =>
  lines
    .map((l) =>
      l.citations.length > 0
        ? `${l.text} ${l.citations.map((c) => `[${c}]`).join(' ')}`
        : l.text,
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

const assemble = (
  input: AskInput,
  kind: AskKind,
  lines: AskLine[],
  meta: Pick<AskAnswer, 'used_fallback' | 'attempts' | 'failures' | 'report'>,
): AskAnswer => ({
  question: input.question,
  kind,
  lines,
  text: renderText(lines),
  ...meta,
});

const deterministicAnswer = (
  input: AskInput,
  intent: AskIntent,
  candidates: AskCandidates,
  meta: Pick<AskAnswer, 'attempts' | 'failures' | 'report'>,
): AskAnswer => {
  const built = buildDeterministic(input, intent, candidates);
  return assemble(input, built.kind, built.lines, { ...meta, used_fallback: true });
};

const emptyReport = (): AskReport => ({
  stripped_sentences: [],
  stripped_citations: [],
  violations: [],
});

const kindFor = (intent: AskIntent, lines: readonly AskLine[]): AskKind => {
  if (intent === 'verdict') return 'verdict_refusal';
  if (intent === 'watched_terms') return 'watched_terms';
  if (intent === 'coverage') return 'coverage';
  return lines.some((l) => l.citations.length > 0) ? 'observations' : 'not_observed';
};

export const answerQuestion = async (
  input: AskInput,
  deps: AskDeps,
): Promise<AskAnswer> => {
  const intent = classifyIntent(input.question);
  const scope = detectCompanyScope(input.question, input);
  const candidates = retrieveCandidates(input, intent, scope);

  // Coverage does not count: non-coverage intents cite signals, deals and
  // runs, and a model with nothing citable can only refuse or invent.
  const hasCandidates =
    candidates.signals.length > 0 ||
    candidates.deals.length > 0 ||
    candidates.runs.length > 0;

  if (deps.client === null) {
    return deterministicAnswer(input, intent, candidates, {
      attempts: 0,
      failures: [{ attempt: 0, reason: 'no ask client (no ANTHROPIC_API_KEY)' }],
      report: emptyReport(),
    });
  }

  // Coverage questions are answered by the coverage record itself, verbatim.
  if (intent === 'coverage' || !hasCandidates) {
    return deterministicAnswer(input, intent, candidates, {
      attempts: 0,
      failures: [
        {
          attempt: 0,
          reason:
            intent === 'coverage'
              ? 'coverage questions are answered by code (coverage is verbatim, never paraphrased)'
              : 'no candidate records; a model with nothing to cite can only invent',
        },
      ],
      report: emptyReport(),
    });
  }

  const request = buildAskRequest(input.question, intent, candidates, deps.env);
  const failures: { attempt: number; reason: string }[] = [];
  let attempts = 0;

  for (let attempt = 1; attempt <= ASK_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    try {
      const response = await deps.client.createMessage(request);
      const draft = askDraftSchema.parse(extractJson(responseText(response.content)));
      const gated = checkAnswer(draft.answer, {
        signals: candidates.signals,
        deals: candidates.deals,
        runs: candidates.runs,
        coverage_count: candidates.coverage.length,
      });
      deps.onReport?.(gated.report, 'answer');
      if (gated.ok) {
        let lines = gated.lines;
        // Refusal and watched-term framings are guaranteed by code when the
        // model did not supply them -- the property never rests on phrasing.
        if (intent === 'verdict') lines = [...refusalPrefixLines(lines), ...lines];
        if (intent === 'watched_terms') {
          lines = [...lines, ...watchedTermSuffixLines(lines, candidates)];
        }
        return assemble(input, kindFor(intent, lines), lines, {
          used_fallback: false,
          attempts,
          failures,
          report: gated.report,
        });
      }
      failures.push({
        attempt,
        reason: gated.report.violations.map((v) => `${v.rule}: ${v.detail}`).join('; '),
      });
    } catch (err) {
      failures.push({ attempt, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return deterministicAnswer(input, intent, candidates, {
    attempts,
    failures,
    report: emptyReport(),
  });
};
