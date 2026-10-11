import { describe, it, expect } from 'vitest';
import { createBrightDataClient } from './client.js';
import { MemoryCassetteStore } from './cassette.js';
import { isFetchError } from './errors.js';

/**
 * A Bright Data policy refusal is the nastiest failure shape in the system: a
 * 200 with an empty body. Every primary-source portal we originally targeted
 * (Ohio SoS, Franklin County, Ohio JFS, OFAC, SEC) is classified Government and
 * refused this way. Reading it as success would mean reporting "no change
 * observed" about a source we were never allowed to read.
 */
function refusingFetch(host: string) {
  return async () => ({
    status: 200,
    ok: true,
    text: async () => '',
    headers: {
      get: (n: string) =>
        n.toLowerCase() === 'x-brd-error'
          ? `Access denied: ${host} is classified as Government and blocked by Bright Data as it might breach Bright Data usage policy`
          : n.toLowerCase() === 'x-brd-status-code' ? '502' : null,
    },
  });
}

const client = (fetchImpl: never) => createBrightDataClient({
  mode: 'live',
  env: {
    BRIGHTDATA_API_KEY: 'k',
    BRIGHTDATA_UNLOCKER_ZONE: 'web_unlocker1',
    BRIGHTDATA_SERP_ZONE: 'serp_api1',
  } as NodeJS.ProcessEnv,
  store: new MemoryCassetteStore(),
  fetchImpl,
});

describe('a policy refusal is an error, never an empty success', () => {
  it('throws on a 200-with-empty-body refusal', async () => {
    const c = client(refusingFetch('businesssearch.ohiosos.gov') as never);
    await expect(c.unlocker('https://businesssearch.ohiosos.gov/')).rejects.toThrow();
  });

  it('names the host, quotes the refusal, and says the body was empty', async () => {
    const c = client(refusingFetch('fcdcfcjs.co.franklin.oh.us') as never);
    const err = await c.unlocker('https://fcdcfcjs.co.franklin.oh.us/x').catch((e) => e);
    expect(isFetchError(err)).toBe(true);
    expect(err.code).toBe('POLICY_REFUSED');
    expect(err.message).toContain('fcdcfcjs.co.franklin.oh.us');
    expect(err.message).toContain('classified as Government');
    expect(err.message).toContain('0 bytes');
  });

  it('says a different scraper will not help, because the block is on the domain', () => {
    // The guidance belongs in the error: the next person to hit this will
    // otherwise spend an hour writing a custom scraper that gets refused too.
    const c = client(refusingFetch('jfs.ohio.gov') as never);
    return c.unlocker('https://jfs.ohio.gov/').catch((e) => {
      expect(e.message).toMatch(/non-government equivalent/);
    });
  });

  it('does NOT fire on an ordinary successful fetch', async () => {
    const ok = (async () => ({
      status: 200, ok: true, text: async () => '<html>real page</html>',
      headers: { get: () => null },
    })) as never;
    const c = client(ok);
    const r = await c.unlocker('https://example.com');
    expect(r.body).toContain('real page');
  });
});

/**
 * A render failure is NOT a policy refusal, and the difference is operational.
 * Observed live on 2026-10-11: the executives SERP came back
 * `x-brd-error-code: expect_element` -- "waiting for selector \"#main\"
 * failed: timeout 30000ms exceeded" -- with `x-brd-status-code: 502`, exactly
 * like a government block. It was reported as REFUSED BY POLICY and never
 * retried, so a working source looked like an unreachable one.
 */
const RENDER_TIMEOUT = 'waiting for selector "#main" failed: timeout 30000ms exceeded';

function brdReply(error: string | null, code: string | null, body = '') {
  return {
    status: 200,
    ok: true,
    text: async () => body,
    headers: {
      get: (n: string) => {
        const name = n.toLowerCase();
        if (name === 'x-brd-error') return error;
        if (name === 'x-brd-error-code') return code;
        if (name === 'x-brd-status-code') return error === null ? '200' : '502';
        return null;
      },
    },
  };
}

/** Replies in order, repeating the last -- enough to exercise the retry path. */
function sequence(replies: ReturnType<typeof brdReply>[]) {
  let i = 0;
  const calls = { count: 0 };
  const impl = async () => {
    calls.count += 1;
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return reply;
  };
  return { impl, calls };
}

describe('a render failure is retried, not reported as policy', () => {
  it('retries and succeeds when the next attempt renders', async () => {
    const net = sequence([
      brdReply(RENDER_TIMEOUT, 'expect_element'),
      brdReply(null, null, '<html>rendered</html>'),
    ]);
    const c = createBrightDataClient({
      mode: 'live',
      env: { BRIGHTDATA_API_KEY: 'k', BRIGHTDATA_SERP_ZONE: 'serp_api1' } as NodeJS.ProcessEnv,
      store: new MemoryCassetteStore(),
      fetchImpl: net.impl as never,
      backoffMs: 0,
    });

    const res = await c.serp('"Big Lots, Inc." appoints CEO');

    expect(res.body).toContain('rendered');
    expect(net.calls.count).toBe(2);
    expect(res.credits_spent).toBe(1);
  });

  it('exhausts retries and says explicitly that it was not a policy refusal', async () => {
    const net = sequence([brdReply(RENDER_TIMEOUT, 'expect_element')]);
    const c = createBrightDataClient({
      mode: 'live',
      env: { BRIGHTDATA_API_KEY: 'k', BRIGHTDATA_SERP_ZONE: 'serp_api1' } as NodeJS.ProcessEnv,
      store: new MemoryCassetteStore(),
      fetchImpl: net.impl as never,
      backoffMs: 0,
    });

    const err = await c.serp('"Big Lots, Inc." appoints CEO').catch((e) => e);

    expect(isFetchError(err)).toBe(true);
    expect(err.code).not.toBe('POLICY_REFUSED');
    expect(err.message).toContain('NOT a');
    expect(err.message).toContain('expect_element');
    expect(net.calls.count).toBe(3);
  });

  it('still refuses a policy block on the first attempt, with no retry', async () => {
    const net = sequence([
      brdReply(
        'Access denied: jfs.ohio.gov is classified as Government and blocked by Bright Data',
        'proxy_error',
      ),
    ]);
    const c = client(net.impl as never);

    const err = await c.unlocker('https://jfs.ohio.gov/').catch((e) => e);

    expect(err.code).toBe('POLICY_REFUSED');
    expect(net.calls.count).toBe(1);
  });

  it('classifies the residential robots.txt/KYC refusal as policy', async () => {
    const net = sequence([
      brdReply(
        'Residential Failed (bad_endpoint): Requested site is not available for immediate ' +
          'residential (no KYC) access mode in accordance with robots.txt',
        'policy_20140',
      ),
    ]);
    const c = client(net.impl as never);

    const err = await c.unlocker('https://www.opensanctions.org/search/?q=x').catch((e) => e);

    expect(err.code).toBe('POLICY_REFUSED');
    expect(net.calls.count).toBe(1);
  });
});
