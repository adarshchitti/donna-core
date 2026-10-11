import { describe, it, expect } from 'vitest';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchCacheKey } from '@donna/contracts';
import { createBrightDataClient } from './client.js';
import { cassetteFileName, MemoryCassetteStore } from './cassette.js';
import {
  BRIGHTDATA_ENDPOINT,
  assertLiveEnv,
  missingLiveEnv,
  readApiKeys,
  resolveFetchMode,
} from './config.js';
import { CassetteMissError, CreditCeilingError, FetchError } from './errors.js';
import { forbiddenFetch, stubFetch } from './testing.js';
import { cassetteSchema } from './types.js';
import {
  CASSETTE_DIR,
  PINNED_DAY,
  RECORDED_PAGE_URL,
  otherDayNow,
  pinnedNow,
} from './fixtures.test-util.js';

const CREDS = {
  apiKey: 'test-key-abc',
  unlockerZone: 'donna_unlocker',
  serpZone: 'donna_serp',
} as const;

/** No env is ever read in these tests: `env: {}` stands in for a bare shell. */
const BARE_ENV = {} as const;

const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'donna-cassette-'));

describe('replay mode', () => {
  it('returns the recorded cassette body for a recorded URL', async () => {
    const net = forbiddenFetch();
    const client = createBrightDataClient({
      mode: 'replay',
      env: BARE_ENV,
      cassetteDir: CASSETTE_DIR,
      now: pinnedNow,
      fetchImpl: net.impl,
    });

    const res = await client.unlocker(RECORDED_PAGE_URL);

    expect(res.body).toContain('HARTWELL LOGISTICS LLC');
    expect(res.url).toBe(RECORDED_PAGE_URL);
    expect(net.calls).toHaveLength(0);
  });

  it('throws an error naming the URL on a cassette miss', async () => {
    const client = createBrightDataClient({
      mode: 'replay',
      env: BARE_ENV,
      cassetteDir: CASSETTE_DIR,
      now: pinnedNow,
      fetchImpl: forbiddenFetch().impl,
    });
    const missing = 'https://court.example.gov/docket/24-CV-7781';

    const err = await client.unlocker(missing).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CassetteMissError);
    const message = (err as Error).message;
    expect(message).toContain(missing);
    expect(message).toContain(fetchCacheKey(missing, PINNED_DAY));
    // The expected path is named, because a sha256 filename is unguessable.
    expect(message).toContain(cassetteFileName(fetchCacheKey(missing, PINNED_DAY)));
    expect((err as CassetteMissError).code).toBe('CASSETTE_MISS');
  });

  it('reports cache_hit: true and credits_spent: 0 on a hit', async () => {
    const client = createBrightDataClient({
      mode: 'replay',
      env: BARE_ENV,
      cassetteDir: CASSETTE_DIR,
      now: pinnedNow,
      fetchImpl: forbiddenFetch().impl,
    });

    const res = await client.unlocker(RECORDED_PAGE_URL);

    expect(res.cache_hit).toBe(true);
    expect(res.credits_spent).toBe(0);
    expect(client.creditsSpent()).toBe(0);
    // The recorded instant, not now: evidence carries the real fetch time.
    expect(res.fetched_at).toBe('2026-10-10T09:15:00.000Z');
  });
});

describe('mode defaults', () => {
  it('defaults to replay when DONNA_FETCH_MODE is unset', () => {
    expect(resolveFetchMode({})).toBe('replay');
    expect(resolveFetchMode({ DONNA_FETCH_MODE: '' })).toBe('replay');
    expect(createBrightDataClient({ env: BARE_ENV }).mode).toBe('replay');
  });

  it('a bare run cannot hit the network or spend a credit', async () => {
    const net = forbiddenFetch();
    const client = createBrightDataClient({
      // No `mode`, no DONNA_FETCH_MODE: exactly a careless `npm test`.
      env: BARE_ENV,
      cassetteDir: CASSETTE_DIR,
      now: pinnedNow,
      fetchImpl: net.impl,
      ...CREDS,
    });

    await expect(client.unlocker('https://news.example.com/anything')).rejects.toBeInstanceOf(
      CassetteMissError,
    );
    expect(net.calls).toHaveLength(0);
    expect(client.creditsSpent()).toBe(0);
  });

  it('rejects an unrecognised DONNA_FETCH_MODE rather than guessing', () => {
    expect(() => resolveFetchMode({ DONNA_FETCH_MODE: 'LIVE!' })).toThrow(/live\|record\|replay/);
  });
});

describe('record then replay', () => {
  it('writes a cassette and replays it back identically', async () => {
    const dir = await tempDir();
    const url = 'https://layoffs.example.gov/warn/2026/hartwell.html';
    const body = '<html><body><h1>WARN notice</h1></body></html>';
    const net = stubFetch([{ status: 200, body }]);

    const recorder = createBrightDataClient({
      mode: 'record',
      env: BARE_ENV,
      cassetteDir: dir,
      now: pinnedNow,
      fetchImpl: net.impl,
      ...CREDS,
    });
    const recorded = await recorder.unlocker(url);

    expect(recorded.cache_hit).toBe(false);
    expect(recorded.credits_spent).toBe(1);
    expect(net.calls).toHaveLength(1);

    // On disk: one file, hash-named, carrying the URL sidecar.
    const files = await readdir(dir);
    expect(files).toEqual([cassetteFileName(fetchCacheKey(url, PINNED_DAY))]);
    const onDisk = cassetteSchema.parse(
      JSON.parse(await readFile(join(dir, files[0]!), 'utf8')) as unknown,
    );
    expect(onDisk.url).toBe(url);
    expect(onDisk.day).toBe(PINNED_DAY);
    expect(onDisk.zone).toBe(CREDS.unlockerZone);

    const replayer = createBrightDataClient({
      mode: 'replay',
      env: BARE_ENV,
      cassetteDir: dir,
      now: pinnedNow,
      fetchImpl: forbiddenFetch().impl,
    });
    const replayed = await replayer.unlocker(url);

    expect(replayed.body).toBe(recorded.body);
    expect(replayed.fetched_at).toBe(recorded.fetched_at);
    expect(replayed.url).toBe(recorded.url);
    expect(replayed.cache_hit).toBe(true);
    expect(replayed.credits_spent).toBe(0);
  });

  it('a same-day re-run in record mode costs zero credits', async () => {
    const dir = await tempDir();
    const url = 'https://layoffs.example.gov/warn/2026/second.html';
    const net = stubFetch([{ status: 200, body: 'first and only network response' }]);
    const client = createBrightDataClient({
      mode: 'record',
      env: BARE_ENV,
      cassetteDir: dir,
      now: pinnedNow,
      fetchImpl: net.impl,
      ...CREDS,
    });

    const first = await client.unlocker(url);
    const second = await client.unlocker(url);

    expect(first.credits_spent).toBe(1);
    expect(second.credits_spent).toBe(0);
    expect(second.cache_hit).toBe(true);
    expect(client.creditsSpent()).toBe(1);
    expect(net.calls).toHaveLength(1);
  });
});

describe('the cassette key is URL + UTC day', () => {
  it('misses the same URL on a different day', async () => {
    const tomorrow = createBrightDataClient({
      mode: 'replay',
      env: BARE_ENV,
      cassetteDir: CASSETTE_DIR,
      now: otherDayNow,
      fetchImpl: forbiddenFetch().impl,
    });

    await expect(tomorrow.unlocker(RECORDED_PAGE_URL)).rejects.toBeInstanceOf(CassetteMissError);

    // Same URL, same store, pinned day: a hit. Only the day changed.
    const today = createBrightDataClient({
      mode: 'replay',
      env: BARE_ENV,
      cassetteDir: CASSETTE_DIR,
      now: pinnedNow,
      fetchImpl: forbiddenFetch().impl,
    });
    await expect(today.unlocker(RECORDED_PAGE_URL)).resolves.toMatchObject({ cache_hit: true });
  });

  it('keys exactly as fetchCacheKey() in contracts does', async () => {
    const store = new MemoryCassetteStore();
    const url = 'https://domain.example.com/whois/hartwell';
    const client = createBrightDataClient({
      mode: 'record',
      env: BARE_ENV,
      store,
      now: pinnedNow,
      fetchImpl: stubFetch([{ status: 200, body: 'whois' }]).impl,
      ...CREDS,
    });

    await client.unlocker(url);

    const key = fetchCacheKey(url, PINNED_DAY);
    expect(key).toBe(`${PINNED_DAY}|${url}`);
    expect(await store.get(key)).toMatchObject({ key, url, day: PINNED_DAY });
  });
});

describe('credit accounting', () => {
  it('charges 1 credit per live request and accumulates', async () => {
    const net = stubFetch([{ status: 200, body: 'a' }, { status: 200, body: 'b' }]);
    const client = createBrightDataClient({
      mode: 'live',
      env: BARE_ENV,
      store: new MemoryCassetteStore(),
      now: pinnedNow,
      fetchImpl: net.impl,
      ...CREDS,
    });

    const first = await client.unlocker('https://a.example.com/');
    expect(first.credits_spent).toBe(1);
    expect(first.cache_hit).toBe(false);
    expect(client.creditsSpent()).toBe(1);

    const second = await client.unlocker('https://b.example.com/');
    expect(second.credits_spent).toBe(1);
    expect(client.creditsSpent()).toBe(2);
    expect(client.credits()).toEqual({ spent: 2, ceiling: undefined, remaining: undefined });
  });

  it('throws CreditCeilingError once the ceiling is reached, and replay still works', async () => {
    const net = stubFetch([{ status: 200, body: 'spent it' }]);
    const client = createBrightDataClient({
      mode: 'live',
      env: BARE_ENV,
      // The committed cassettes double as this client's fetch cache, so we can
      // prove a cached read still works after the ceiling is reached.
      cassetteDir: CASSETTE_DIR,
      now: pinnedNow,
      fetchImpl: net.impl,
      creditCeiling: 1,
      ...CREDS,
    });

    await client.unlocker('https://first.example.com/');
    expect(client.credits()).toEqual({ spent: 1, ceiling: 1, remaining: 0 });

    const err = await client.unlocker('https://second.example.com/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreditCeilingError);
    expect((err as CreditCeilingError).code).toBe('CREDIT_CEILING');
    expect((err as Error).message).toMatch(/1\/1 credits spent/);
    // Refused, not spent.
    expect(client.creditsSpent()).toBe(1);
    expect(net.calls).toHaveLength(1);

    // A cache hit is free, so the ceiling never blocks it.
    await expect(client.unlocker(RECORDED_PAGE_URL)).resolves.toMatchObject({
      cache_hit: true,
      credits_spent: 0,
    });

    // And a replay-mode client is unaffected entirely.
    const replayer = createBrightDataClient({
      mode: 'replay',
      env: BARE_ENV,
      cassetteDir: CASSETTE_DIR,
      now: pinnedNow,
      creditCeiling: 1,
      fetchImpl: forbiddenFetch().impl,
    });
    await expect(replayer.unlocker(RECORDED_PAGE_URL)).resolves.toMatchObject({ cache_hit: true });
  });

  it('reads the ceiling from the environment, under either accepted name', () => {
    expect(createBrightDataClient({ env: { DONNA_CREDIT_CEILING: '250' } }).creditCeiling).toBe(250);
    expect(
      createBrightDataClient({ env: { DONNA_FETCH_CREDIT_CEILING: '300' } }).creditCeiling,
    ).toBe(300);
    expect(createBrightDataClient({ env: {} }).creditCeiling).toBeUndefined();
    // Garbage is ignored rather than parsed into a surprising ceiling of NaN.
    expect(createBrightDataClient({ env: { DONNA_CREDIT_CEILING: 'lots' } }).creditCeiling)
      .toBeUndefined();
  });
});

describe('request shape', () => {
  const shapeClient = (zoneOverrides: Partial<typeof CREDS> = {}) => {
    const net = stubFetch([{ status: 200, body: '<html></html>' }]);
    const client = createBrightDataClient({
      mode: 'live',
      env: BARE_ENV,
      store: new MemoryCassetteStore(),
      now: pinnedNow,
      fetchImpl: net.impl,
      ...CREDS,
      ...zoneOverrides,
    });
    return { net, client };
  };

  it('posts the documented envelope to the one Bright Data endpoint', async () => {
    const { net, client } = shapeClient();
    const target = 'https://registry.example.gov/company/42';

    await client.unlocker(target);

    expect(net.calls).toHaveLength(1);
    const call = net.calls[0]!;
    expect(call.url).toBe('https://api.brightdata.com/request');
    expect(call.url).toBe(BRIGHTDATA_ENDPOINT);
    expect(call.init.method).toBe('POST');
    expect(call.init.headers['Authorization']).toBe(`Bearer ${CREDS.apiKey}`);
    expect(call.init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(call.init.body) as unknown).toEqual({
      zone: 'donna_unlocker',
      url: target,
      format: 'raw',
    });
  });

  it('uses the unlocker zone for unlocker() and the SERP zone for serp()', async () => {
    const unlock = shapeClient();
    await unlock.client.unlocker('https://page.example.com/');
    const unlockBody = JSON.parse(unlock.net.calls[0]!.init.body) as { zone: string; url: string };
    expect(unlockBody.zone).toBe('donna_unlocker');

    const search = shapeClient();
    await search.client.serp('hartwell logistics layoffs');
    const serpBody = JSON.parse(search.net.calls[0]!.init.body) as { zone: string; url: string };
    expect(serpBody.zone).toBe('donna_serp');
    // The SERP product still takes a URL -- a search-engine one.
    expect(serpBody.url).toContain('https://www.google.com/search?q=');
  });

  it('refuses a live fetch with no API key, without calling out', async () => {
    const net = stubFetch([{ status: 200, body: 'never' }]);
    const client = createBrightDataClient({
      mode: 'live',
      env: BARE_ENV,
      store: new MemoryCassetteStore(),
      now: pinnedNow,
      fetchImpl: net.impl,
      unlockerZone: 'donna_unlocker',
    });

    const err = await client.unlocker('https://page.example.com/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).code).toBe('CONFIG');
    expect((err as Error).message).toContain('BRIGHTDATA_API_KEY');
    expect(net.calls).toHaveLength(0);
  });
});

describe('a 200 that is really a refusal', () => {
  // Verbatim body from a live call putting an Ohio registry URL through the
  // SERP zone. HTTP 200, so nothing about the status reveals the problem.
  const REFUSAL =
    "This target URL isn't supported with SERP API, " +
    'use the Web Unlocker product for targeting this URL';

  it('surfaces it as an UNSUPPORTED_TARGET error instead of an empty snapshot', async () => {
    const net = stubFetch([{ status: 200, body: REFUSAL }]);
    const client = createBrightDataClient({
      mode: 'live',
      env: BARE_ENV,
      store: new MemoryCassetteStore(),
      now: pinnedNow,
      fetchImpl: net.impl,
      ...CREDS,
    });

    const err = await client
      .unlocker('https://businesssearch.ohiosos.gov/')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).code).toBe('UNSUPPORTED_TARGET');
    expect((err as FetchError).url).toBe('https://businesssearch.ohiosos.gov/');
    expect((err as Error).message).toContain('https://businesssearch.ohiosos.gov/');
    expect((err as Error).message).toContain('BRIGHTDATA_UNLOCKER_ZONE');
    // The request was billed, so the running total stays honest.
    expect(client.creditsSpent()).toBe(1);
  });

  it('never records it as a cassette', async () => {
    const dir = await tempDir();
    const net = stubFetch([{ status: 200, body: REFUSAL }]);
    const client = createBrightDataClient({
      mode: 'record',
      env: BARE_ENV,
      cassetteDir: dir,
      now: pinnedNow,
      fetchImpl: net.impl,
      ...CREDS,
    });

    await expect(client.unlocker('https://businesssearch.ohiosos.gov/')).rejects.toBeInstanceOf(
      FetchError,
    );
    // A 200 full of an error message would otherwise become a permanent,
    // convincing-looking fixture.
    expect(await readdir(dir)).toEqual([]);
  });

  it('rejects a cached refusal too, so a bad cassette cannot be replayed as a page', async () => {
    const store = new MemoryCassetteStore();
    const url = 'https://businesssearch.ohiosos.gov/';
    const key = fetchCacheKey(url, PINNED_DAY);
    await store.put({
      key,
      url,
      day: PINNED_DAY,
      zone: 'serp_api1',
      status: 200,
      fetched_at: `${PINNED_DAY}T09:15:00.000Z`,
      body: REFUSAL,
    });
    const client = createBrightDataClient({
      mode: 'replay',
      env: BARE_ENV,
      store,
      now: pinnedNow,
      fetchImpl: forbiddenFetch().impl,
    });

    const err = await client.unlocker(url).catch((e: unknown) => e);
    expect((err as FetchError).code).toBe('UNSUPPORTED_TARGET');
    expect(client.creditsSpent()).toBe(0);
  });
});

describe('robustness', () => {
  const noWait = async (): Promise<void> => {};

  it('retries a 429 and succeeds', async () => {
    const net = stubFetch([
      { status: 429, body: 'slow down' },
      { status: 200, body: 'got there' },
    ]);
    const client = createBrightDataClient({
      mode: 'live',
      env: BARE_ENV,
      store: new MemoryCassetteStore(),
      now: pinnedNow,
      fetchImpl: net.impl,
      sleep: noWait,
      ...CREDS,
    });

    const res = await client.unlocker('https://throttled.example.com/');

    expect(res.body).toBe('got there');
    expect(net.calls).toHaveLength(2);
    // Two HTTP attempts, one successful request: one credit.
    expect(client.creditsSpent()).toBe(1);
  });

  it('does NOT retry a 403', async () => {
    const net = stubFetch([{ status: 403, body: 'forbidden' }]);
    const client = createBrightDataClient({
      mode: 'live',
      env: BARE_ENV,
      store: new MemoryCassetteStore(),
      now: pinnedNow,
      fetchImpl: net.impl,
      sleep: noWait,
      ...CREDS,
    });

    const err = await client.unlocker('https://blocked.example.com/').catch((e: unknown) => e);

    expect(net.calls).toHaveLength(1);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).code).toBe('HTTP');
    expect(client.creditsSpent()).toBe(0);
  });

  it('retries a 500 up to the limit, then wraps the failure with URL and mode', async () => {
    const net = stubFetch([{ status: 503, body: 'upstream down' }]);
    const client = createBrightDataClient({
      mode: 'live',
      env: BARE_ENV,
      store: new MemoryCassetteStore(),
      now: pinnedNow,
      fetchImpl: net.impl,
      sleep: noWait,
      maxRetries: 2,
      ...CREDS,
    });

    const err = await client.unlocker('https://down.example.com/').catch((e: unknown) => e);

    expect(net.calls).toHaveLength(3);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).url).toBe('https://down.example.com/');
    expect((err as FetchError).mode).toBe('live');
    expect((err as Error).message).toContain('3 attempt(s)');
  });

  it('wraps a raw network error instead of letting it escape', async () => {
    const net = stubFetch([new Error('ECONNRESET')]);
    const client = createBrightDataClient({
      mode: 'live',
      env: BARE_ENV,
      store: new MemoryCassetteStore(),
      now: pinnedNow,
      fetchImpl: net.impl,
      sleep: noWait,
      maxRetries: 1,
      ...CREDS,
    });

    const err = await client.unlocker('https://flaky.example.com/').catch((e: unknown) => e);

    expect(net.calls).toHaveLength(2);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).code).toBe('NETWORK');
    expect((err as Error).message).toContain('ECONNRESET');
    expect((err as Error).message).toContain('https://flaky.example.com/');
  });

  it('times out a hanging request and reports it as a timeout', async () => {
    const hangs = async (
      _url: string,
      init: { signal?: AbortSignal },
    ): Promise<never> =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const client = createBrightDataClient({
      mode: 'live',
      env: BARE_ENV,
      store: new MemoryCassetteStore(),
      now: pinnedNow,
      fetchImpl: hangs,
      sleep: noWait,
      maxRetries: 0,
      timeoutMs: 5,
      ...CREDS,
    });

    const err = await client.unlocker('https://slow.example.com/').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).code).toBe('TIMEOUT');
    expect((err as Error).message).toContain('timed out after 5ms');
  });
});

describe('credential rotation', () => {
  const PAGE = 'https://registry.example.com/company/1';

  it('moves to the next key when one is rejected, and reports which', async () => {
    const net = stubFetch([
      { status: 401, body: 'Auth failed' },
      { status: 200, body: '<html>second key worked</html>' },
    ]);
    const client = createBrightDataClient({
      mode: 'record',
      env: BARE_ENV,
      apiKeys: ['key-one', 'key-two'],
      unlockerZone: CREDS.unlockerZone,
      serpZone: CREDS.serpZone,
      store: new MemoryCassetteStore(),
      now: pinnedNow,
      fetchImpl: net.impl,
      backoffMs: 0,
    });

    const res = await client.unlocker(PAGE);

    expect(res.body).toContain('second key worked');
    expect(net.calls).toHaveLength(2);
    expect(net.calls[0]?.init.headers?.Authorization).toBe('Bearer key-one');
    expect(net.calls[1]?.init.headers?.Authorization).toBe('Bearer key-two');
    // One request billed, not two: the rejected call never served a page.
    expect(client.creditsSpent()).toBe(1);
  });

  it('gives up once every key is exhausted, without naming the keys', async () => {
    const net = stubFetch([{ status: 402, body: 'Out of budget' }]);
    const client = createBrightDataClient({
      mode: 'record',
      env: BARE_ENV,
      apiKeys: ['key-one', 'key-two'],
      unlockerZone: CREDS.unlockerZone,
      serpZone: CREDS.serpZone,
      store: new MemoryCassetteStore(),
      now: pinnedNow,
      fetchImpl: net.impl,
      backoffMs: 0,
    });

    const err = await client.unlocker(PAGE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).code).toBe('HTTP');
    expect((err as Error).message).toContain('key 2 of 2');
    expect((err as Error).message).not.toContain('key-one');
    expect(net.calls).toHaveLength(2);
    expect(client.creditsSpent()).toBe(0);
  });

  it('does not rotate on a failure the next key cannot fix', async () => {
    const net = stubFetch([{ status: 400, body: 'Bad target URL' }]);
    const client = createBrightDataClient({
      mode: 'record',
      env: BARE_ENV,
      apiKeys: ['key-one', 'key-two'],
      unlockerZone: CREDS.unlockerZone,
      serpZone: CREDS.serpZone,
      store: new MemoryCassetteStore(),
      now: pinnedNow,
      fetchImpl: net.impl,
      backoffMs: 0,
    });

    await expect(client.unlocker(PAGE)).rejects.toThrow(FetchError);
    expect(net.calls).toHaveLength(1);
  });

  it('reads the rotation order from BRIGHTDATA_API_KEYS', () => {
    expect(
      readApiKeys({ BRIGHTDATA_API_KEYS: 'k1, k3, k2', BRIGHTDATA_API_KEY: 'k1' }),
    ).toEqual(['k1', 'k3', 'k2']);
    // The single-key spelling still works, and is not dropped when the list omits it.
    expect(readApiKeys({ BRIGHTDATA_API_KEY: 'solo' })).toEqual(['solo']);
    expect(readApiKeys({ BRIGHTDATA_API_KEYS: 'k2', BRIGHTDATA_API_KEY: 'k1' })).toEqual(['k1', 'k2']);
    expect(readApiKeys({})).toEqual([]);
  });
});

describe('live-env preflight', () => {
  const FULL = {
    BRIGHTDATA_API_KEY: 'k',
    BRIGHTDATA_UNLOCKER_ZONE: 'web_unlocker1',
    BRIGHTDATA_SERP_ZONE: 'serp_api1',
  };

  it('names every missing variable at once', () => {
    expect(missingLiveEnv(FULL)).toEqual([]);
    expect(missingLiveEnv({ BRIGHTDATA_API_KEY: 'k' })).toEqual([
      'BRIGHTDATA_UNLOCKER_ZONE',
      'BRIGHTDATA_SERP_ZONE',
    ]);
  });

  it('throws a CONFIG error naming the unlocker zone, the one that was missing', () => {
    const err = (() => {
      try {
        assertLiveEnv({ ...FULL, BRIGHTDATA_UNLOCKER_ZONE: '' }, 'record');
        return undefined;
      } catch (e: unknown) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).code).toBe('CONFIG');
    expect((err as Error).message).toContain('BRIGHTDATA_UNLOCKER_ZONE');
    expect(() => assertLiveEnv(FULL)).not.toThrow();
  });
});
