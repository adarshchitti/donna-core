import type { Briefing } from '@donna/contracts';
import { clientFromEnv, type NarratorClient } from './model.js';
import { buildNarratorRequest } from './prompt.js';
import { postProcess, type PostProcessReport } from './postprocess.js';
import { buildFallbackDraft } from './fallback.js';
import { narratorDraftSchema, type NarratorInput } from './types.js';

/**
 * One Claude call per cluster, then the gate.
 *
 * Degradation ladder, in order:
 *   no client (no API key)        -> fallback, and NO network call is attempted
 *   transport or JSON failure     -> retry once, then fallback
 *   draft schema failure          -> retry once, then fallback
 *   post-processor rejection      -> retry once, then fallback
 *
 * Exactly one retry. A second bad draft from the same prompt on the same input
 * is not bad luck, and a third call costs money to produce the same table the
 * fallback produces for free.
 */

export const NARRATOR_ATTEMPTS = 2;

export interface NarrateFailure {
  attempt: number;
  reason: string;
}

export interface NarrateResult {
  briefing: Briefing;
  /** Mirrors briefing.narration_status; here so callers need not re-read it. */
  used_fallback: boolean;
  /** Model calls actually made. 0 when there was no client. */
  attempts: number;
  failures: NarrateFailure[];
  report: PostProcessReport;
}

export interface NarrateOptions {
  /**
   * Pass `null` for "offline, do not call anything". Omit it and the client is
   * built from the environment, which also yields null when there is no key.
   */
  client?: NarratorClient | null;
  env?: Record<string, string | undefined>;
  now?: string;
  /** Strips and rejections are worth logging; Track C used to lose them silently. */
  onReport?: (report: PostProcessReport, stage: 'narration' | 'fallback') => void;
}

/** Pulls the JSON document out of a response, tolerating a ```json fence. */
export const extractJson = (text: string): unknown => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in response');
  return JSON.parse(body.slice(start, end + 1));
};

const responseText = (content: readonly { type: string; text?: string }[]): string => {
  const text = content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  // The observed failure mode of a thinking-enabled haiku was exactly this:
  // tokens spent, no text block. Naming it makes the log readable.
  if (text.trim() === '') throw new Error('response contained no text block');
  return text;
};

/** The code-built briefing, run through the same gate as model output. */
export const fallbackBriefing = (
  input: NarratorInput,
  opts: Pick<NarrateOptions, 'now' | 'onReport'> = {},
): { briefing: Briefing; report: PostProcessReport } => {
  const draft = buildFallbackDraft(input);
  const result = postProcess(draft, input, {
    narration_status: 'fallback',
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  opts.onReport?.(result.report, 'fallback');
  if (!result.ok) {
    // The fallback is the floor. If it cannot pass our own gate, the gate and
    // the builder disagree and every briefing in the system is suspect, so this
    // throws rather than publishing something unchecked.
    throw new Error(
      `narrator: fallback failed its own post-processor: ${result.report.violations
        .map((v) => `${v.rule} (${v.detail})`)
        .join('; ')}`,
    );
  }
  return { briefing: result.briefing, report: result.report };
};

export const narrate = async (
  input: NarratorInput,
  opts: NarrateOptions = {},
): Promise<NarrateResult> => {
  const client = opts.client !== undefined ? opts.client : clientFromEnv(opts.env);
  const failures: NarrateFailure[] = [];

  if (client === null) {
    const { briefing, report } = fallbackBriefing(input, opts);
    return {
      briefing,
      used_fallback: true,
      attempts: 0,
      failures: [{ attempt: 0, reason: 'no narrator client (no ANTHROPIC_API_KEY)' }],
      report,
    };
  }

  const request = buildNarratorRequest(input, opts.env);
  let attempts = 0;

  for (let attempt = 1; attempt <= NARRATOR_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    try {
      const response = await client.createMessage(request);
      const draft = narratorDraftSchema.parse(extractJson(responseText(response.content)));
      const result = postProcess(draft, input, {
        narration_status: 'available',
        ...(opts.now !== undefined ? { now: opts.now } : {}),
      });
      opts.onReport?.(result.report, 'narration');
      if (result.ok) {
        return { briefing: result.briefing, used_fallback: false, attempts, failures, report: result.report };
      }
      failures.push({
        attempt,
        reason: result.report.violations.map((v) => `${v.rule}: ${v.detail}`).join('; '),
      });
    } catch (err) {
      failures.push({ attempt, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const { briefing, report } = fallbackBriefing(input, opts);
  return { briefing, used_fallback: true, attempts, failures, report };
};
