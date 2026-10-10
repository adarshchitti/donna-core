/**
 * Model choice and the injectable client.
 *
 * The model id is a CONSTANT WITH AN ENV OVERRIDE, not a literal at the call
 * site, so escalating one company (or one book) to a stronger model is a config
 * change rather than a code change.
 *
 * `claude-haiku-4-5-20251001` was chosen empirically, not by tier:
 *   - a newer haiku emitted the forbidden word "breach" in its draft, and with
 *     thinking left at its default it spent ~1200 thinking tokens and returned
 *     no text block at all;
 *   - haiku-4-5 returned clean, schema-valid JSON with correct citations in
 *     ~449 output tokens.
 *
 * A cheap model is safe here ONLY because `postProcess` is a hard gate: a
 * violation is stripped or the whole draft is rejected and we fall back to a
 * briefing built by code. If that gate is ever softened, this model choice stops
 * being defensible. Keep the gate hard.
 */

export const DEFAULT_NARRATOR_MODEL = 'claude-haiku-4-5-20251001';

/** Env override so one company can be escalated without a deploy. */
export const narratorModel = (
  env: Record<string, string | undefined> = process.env,
): string => {
  const override = env['DONNA_NARRATOR_MODEL'];
  return override !== undefined && override.trim() !== ''
    ? override.trim()
    : DEFAULT_NARRATOR_MODEL;
};

/**
 * Thinking is always DISABLED. This workload wants a short JSON document, and
 * with thinking on the observed failure was a response that spent its budget
 * reasoning and returned no text block -- which reads to us as a schema failure
 * and burns a retry for nothing.
 */
export const THINKING_DISABLED = { type: 'disabled' } as const;

/** Small ceiling on purpose: the whole document fits in a few hundred tokens. */
export const NARRATOR_MAX_TOKENS = 1600;

export interface NarratorMessageRequest {
  model: string;
  max_tokens: number;
  thinking: { type: 'disabled' };
  system: string;
  messages: readonly { role: 'user'; content: string }[];
}

export interface NarratorContentBlock {
  type: string;
  text?: string;
}

export interface NarratorMessageResponse {
  content: readonly NarratorContentBlock[];
}

/**
 * The one method the narrator needs. Declared here rather than imported from a
 * vendor SDK so that every test can inject a stub and the whole package runs
 * with no network and no API key.
 */
export interface NarratorClient {
  createMessage(req: NarratorMessageRequest): Promise<NarratorMessageResponse>;
}

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * The real client. Raw HTTP against the Messages API rather than a vendor SDK
 * dependency, because @donna/logic's package.json is frozen for this build and
 * a one-method client is not worth a dependency on a shared lockfile.
 */
export const httpNarratorClient = (apiKey: string): NarratorClient => ({
  createMessage: async (req) => {
    const res = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      throw new Error(`narrator: Anthropic API ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as NarratorMessageResponse;
  },
});

/**
 * No key means no client, which means the fallback path. Returning null rather
 * than throwing is what makes the whole product work offline: the UI degrades
 * to a cited table, never to an error.
 */
export const clientFromEnv = (
  env: Record<string, string | undefined> = process.env,
): NarratorClient | null => {
  const key = env['ANTHROPIC_API_KEY'];
  if (key === undefined || key.trim() === '') return null;
  return httpNarratorClient(key.trim());
};
