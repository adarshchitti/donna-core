import {
  clientFromEnv,
  THINKING_DISABLED,
  type NarratorClient,
  type NarratorMessageRequest,
} from '../narrator/model.js';

/**
 * Model choice and the injectable client for Ask.
 *
 * Same measured choice as the narrator, and for the same reason: the draft
 * goes through a hard gate, so a cheap model is acceptable. `DONNA_ASK_MODEL`
 * overrides independently of the narrator's, so Ask can be escalated without
 * touching briefing narration.
 */
export const DEFAULT_ASK_MODEL = 'claude-haiku-4-5-20251001';

export const askModel = (
  env: Record<string, string | undefined> = process.env,
): string => {
  const override = env['DONNA_ASK_MODEL'];
  return override !== undefined && override.trim() !== ''
    ? override.trim()
    : DEFAULT_ASK_MODEL;
};

/** Thinking is disabled: the observed failure was budget spent, no text block. */
export const ASK_THINKING = THINKING_DISABLED;

/** An answer is a few sentences; the ceiling matches that. */
export const ASK_MAX_TOKENS = 800;

/**
 * The client contract is the narrator's: one `createMessage`. Re-aliased under
 * the Ask name so the public signature reads `deps: { client: AskClient | null }`.
 */
export type AskClient = NarratorClient;
export type AskMessageRequest = NarratorMessageRequest;

/** No key means no client, which means the deterministic path. */
export const askClientFromEnv = clientFromEnv;
