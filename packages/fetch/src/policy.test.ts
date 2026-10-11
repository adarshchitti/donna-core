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
