import { describe, it, expect, vi } from 'vitest';
import { briefingSchema } from '@donna/contracts';
import { narrate, extractJson } from './narrate.js';
import { buildNarratorRequest, SYSTEM_PROMPT } from './prompt.js';
import { clientFromEnv, DEFAULT_NARRATOR_MODEL, narratorModel } from './model.js';
import { MAX_EXCERPT_CHARS } from './types.js';
import { COVERAGE, explodingClient, goodDraft, input, signal, stubClient } from './__fixtures.js';

describe('model configuration', () => {
  it('defaults to the model that was measured, with thinking disabled', () => {
    const req = buildNarratorRequest(input(), {});
    expect(req.model).toBe(DEFAULT_NARRATOR_MODEL);
    expect(req.model).toBe('claude-haiku-4-5-20251001');
    expect(req.thinking).toEqual({ type: 'disabled' });
  });

  it('is overridable by DONNA_NARRATOR_MODEL, so escalation is config', () => {
    expect(narratorModel({ DONNA_NARRATOR_MODEL: 'claude-sonnet-4-6' })).toBe('claude-sonnet-4-6');
    expect(narratorModel({ DONNA_NARRATOR_MODEL: '  ' })).toBe(DEFAULT_NARRATOR_MODEL);
    expect(buildNarratorRequest(input(), { DONNA_NARRATOR_MODEL: 'x' }).model).toBe('x');
  });
});

describe('the narrator is never handed raw page text', () => {
  const page = `BEGIN PAGE ${'filler text about something irrelevant. '.repeat(400)}SENTINEL_END_OF_PAGE`;

  it('sends only summaries and bounded excerpts', () => {
    const inp = input({
      signals: [
        signal({
          evidence: [
            {
              snapshot_id: 'snap-nordvale-registry-2026',
              source: 'registry',
              trust: 'primary',
              excerpt: page,
              url: 'https://donna-sample.invalid/registry/nordvale/latest',
            },
          ],
        }),
      ],
    });
    const body = buildNarratorRequest(inp, {}).messages[0]?.content ?? '';

    // The tail of the page never reaches the prompt...
    expect(page.length).toBeGreaterThan(5000);
    expect(body).not.toContain('SENTINEL_END_OF_PAGE');
    // ...and the excerpt is bounded, not merely trimmed by luck.
    const parsed = JSON.parse(body) as { signals: { evidence_excerpts: string[] }[] };
    for (const s of parsed.signals) {
      for (const e of s.evidence_excerpts) expect(e.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    }

    // No field through which a raw page could travel is present at all.
    expect(body).not.toContain('raw_excerpt');
    expect(body).not.toContain('snapshot_id');
    expect(body).not.toContain('"url"');
    expect(Object.keys(JSON.parse(body) as object).sort()).toEqual([
      'company_id', 'coverage_for_context', 'deals', 'exposure', 'mode', 'signals',
      'verify_with_counterparty', 'window',
    ]);
  });

  it('states the hard constraints in the system prompt', () => {
    const prompt = SYSTEM_PROMPT.toLowerCase();
    for (const phrase of [
      'healthy', 'good standing', 'safe', 'low risk', 'breach',
      'you should', 'you must', 'no change observed', 'worth asking about',
      'square brackets', 'json',
    ]) {
      expect(prompt, phrase).toContain(phrase);
    }
  });
});

describe('no API key -> fallback, with no network call attempted', () => {
  it('resolves no client at all without a key', () => {
    expect(clientFromEnv({})).toBeNull();
    expect(clientFromEnv({ ANTHROPIC_API_KEY: '   ' })).toBeNull();
    expect(clientFromEnv({ ANTHROPIC_API_KEY: 'sk-test' })).not.toBeNull();
  });

  it('falls back without attempting a network call', async () => {
    // fetch is replaced by something that throws: if the no-key path ever starts
    // calling out, this test fails loudly instead of quietly going online.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network call attempted on the no-key path');
    });
    try {
      const result = await narrate(input(), { env: {}, now: '2026-10-10T19:42:30Z' });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.attempts).toBe(0);
      expect(result.used_fallback).toBe(true);
      expect(result.briefing.narration_status).toBe('fallback');
      expect(result.failures[0]?.reason).toContain('no ANTHROPIC_API_KEY');
      expect(briefingSchema.safeParse(result.briefing).success).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('an explicit null client is the same offline path', async () => {
    const result = await narrate(input(), { client: null });
    expect(result.attempts).toBe(0);
    expect(result.used_fallback).toBe(true);
  });

  it('a client that throws on every call still degrades to the table', async () => {
    const result = await narrate(input(), { client: explodingClient() });
    expect(result.used_fallback).toBe(true);
    expect(result.attempts).toBe(2);
  });
});

describe('degradation ladder', () => {
  it('publishes a clean draft without retrying', async () => {
    const client = stubClient([goodDraft()]);
    const result = await narrate(input(), { client, now: '2026-10-10T19:42:30Z' });
    expect(client.calls).toHaveLength(1);
    expect(result.used_fallback).toBe(false);
    expect(result.briefing.narration_status).toBe('available');
    expect(result.briefing.generated_at).toBe('2026-10-10T19:42:30Z');
  });

  it('retries exactly once on a schema failure, then falls back', async () => {
    const client = stubClient([{ not: 'a briefing' }]);
    const result = await narrate(input(), { client });
    expect(client.calls).toHaveLength(2); // one retry, not two
    expect(result.attempts).toBe(2);
    expect(result.used_fallback).toBe(true);
    expect(result.failures).toHaveLength(2);
    expect(briefingSchema.safeParse(result.briefing).success).toBe(true);
  });

  it('retries once then falls back when the response has no text block', async () => {
    const client = { calls: 0, createMessage: async () => { client.calls += 1; return { content: [] }; } };
    const result = await narrate(input(), { client });
    expect(client.calls).toBe(2);
    expect(result.used_fallback).toBe(true);
    expect(result.failures[0]?.reason).toContain('no text block');
  });

  it('accepts a second attempt that is clean', async () => {
    const client = stubClient([{ junk: true }, goodDraft()]);
    const result = await narrate(input(), { client });
    expect(client.calls).toHaveLength(2);
    expect(result.used_fallback).toBe(false);
  });

  it('falls back rather than publishing an emptied what_changed', async () => {
    const draft = goodDraft({
      what_changed: [{ text: 'Ownership moved.', signal_id: 'sig-not-in-cluster' }],
    });
    const client = stubClient([draft]);
    const result = await narrate(input(), { client });
    expect(result.used_fallback).toBe(true);
    expect(result.failures[0]?.reason).toContain('what_changed-empty');
    // The fallback is what makes the Book page safe to dereference at index 0.
    expect(result.briefing.what_changed.length).toBeGreaterThan(0);
    expect(result.briefing.what_changed[0]?.signal_id).toBe('sig-001');
  });

  it('falls back on forbidden language, and the word never reaches the output', async () => {
    const client = stubClient([
      goodDraft({
        headline: 'The counterparty remains in good standing despite the filing [sig-001].',
        why_it_matters:
          'The notice period was breached on 9 October 2026 [sig-001]. Worth asking about the entity.',
      }),
    ]);
    const result = await narrate(input(), { client });
    expect(result.used_fallback).toBe(true);
    const json = JSON.stringify(result.briefing).toLowerCase();
    expect(json).not.toContain('good standing');
    expect(json).not.toContain('breach');
  });

  it('coverage survives the whole ladder byte-identically', async () => {
    const client = stubClient([{ garbage: 1 }]);
    const result = await narrate(input(), { client });
    expect(JSON.stringify(result.briefing.coverage)).toBe(JSON.stringify(COVERAGE));
  });
});

describe('response parsing', () => {
  it('tolerates a ```json fence and surrounding chatter', () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```\nhope that helps')).toEqual({ a: 1 });
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(() => extractJson('no json here')).toThrow();
  });
});
