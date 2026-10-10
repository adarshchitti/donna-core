import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchCacheKey } from '@donna/contracts';
import { FileCassetteStore, MemoryCassetteStore, cassetteFileName } from './cassette.js';
import type { Cassette } from './types.js';
import { CASSETTE_DIR, PINNED_DAY, RECORDED_PAGE_URL } from './fixtures.test-util.js';

const sample = (url: string, day = PINNED_DAY): Cassette => ({
  key: fetchCacheKey(url, day),
  url,
  day,
  zone: 'donna_unlocker',
  status: 200,
  fetched_at: `${day}T09:15:00.000Z`,
  body: '<html>ok</html>',
});

describe('cassette filenames', () => {
  it('is the sha256 of the cache key, so any URL is filesystem-safe', () => {
    const key = fetchCacheKey('https://x.example.com/a/b?c=d&e=f#g', PINNED_DAY);
    const expected = `${createHash('sha256').update(key).digest('hex')}.json`;

    expect(cassetteFileName(key)).toBe(expected);
    expect(cassetteFileName(key)).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  it('differs for the same URL on a different day', () => {
    const url = 'https://x.example.com/a';
    expect(cassetteFileName(fetchCacheKey(url, '2026-10-10'))).not.toBe(
      cassetteFileName(fetchCacheKey(url, '2026-10-11')),
    );
  });
});

describe('FileCassetteStore', () => {
  it('round-trips a cassette and names the path it would use', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'donna-store-'));
    const store = new FileCassetteStore(dir);
    const doc = sample('https://news.example.com/story/1');

    expect(store.locate(doc.key)).toBe(join(dir, cassetteFileName(doc.key)));
    expect(await store.get(doc.key)).toBeUndefined();

    await store.put(doc);
    expect(await store.get(doc.key)).toEqual(doc);
    expect(await readdir(dir)).toHaveLength(1);
  });

  it('keeps the original URL inside the file so a human can read the directory', async () => {
    const store = new FileCassetteStore(CASSETTE_DIR);
    const found = await store.get(fetchCacheKey(RECORDED_PAGE_URL, PINNED_DAY));

    expect(found?.url).toBe(RECORDED_PAGE_URL);
    expect(found?.day).toBe(PINNED_DAY);
  });

  it('refuses a corrupt cassette loudly instead of returning half of one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'donna-store-'));
    const store = new FileCassetteStore(dir);
    const key = fetchCacheKey('https://bad.example.com/', PINNED_DAY);
    await writeFile(store.locate(key), JSON.stringify({ key, url: 'x' }), 'utf8');

    await expect(store.get(key)).rejects.toThrow(/Corrupt cassette/);
  });
});

describe('MemoryCassetteStore', () => {
  it('is interchangeable with the file store', async () => {
    const store = new MemoryCassetteStore();
    const doc = sample('https://jobs.example.com/hartwell');

    expect(await store.get(doc.key)).toBeUndefined();
    await store.put(doc);
    expect(await store.get(doc.key)).toEqual(doc);
    expect(store.size).toBe(1);
    expect(store.locate(doc.key)).toContain(cassetteFileName(doc.key));
  });
});
