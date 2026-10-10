import { describe, it, expect } from 'vitest';
import { createBrightDataClient } from './client.js';
import { parseSerpResults, serpUrl } from './serp.js';
import { forbiddenFetch } from './testing.js';
import { CASSETTE_DIR, RECORDED_SERP_QUERY, pinnedNow } from './fixtures.test-util.js';

const replayClient = () =>
  createBrightDataClient({
    mode: 'replay',
    env: {},
    cassetteDir: CASSETTE_DIR,
    now: pinnedNow,
    fetchImpl: forbiddenFetch().impl,
  });

describe('serpUrl', () => {
  it('builds a stable Google search URL', () => {
    expect(serpUrl('hartwell logistics layoffs')).toBe(
      'https://www.google.com/search?q=hartwell%20logistics%20layoffs&num=10&hl=en&gl=us',
    );
  });

  it('honours engine and num', () => {
    expect(serpUrl('warn notice', { engine: 'bing', num: 5 })).toBe(
      'https://www.bing.com/search?q=warn%20notice&count=5&setlang=en',
    );
  });

  it('is deterministic, so the same query reuses the same cassette and cache entry', () => {
    expect(serpUrl('a b', { engine: 'google', num: 10 })).toBe(serpUrl('a b'));
  });
});

describe('parseSerpResults, against the saved Google SERP cassette', () => {
  it('extracts organic result URLs and titles in rank order', async () => {
    const page = await replayClient().serpResults(RECORDED_SERP_QUERY);

    expect(page.cache_hit).toBe(true);
    expect(page.credits_spent).toBe(0);
    expect(page.results).toEqual([
      {
        rank: 1,
        url: 'https://www.wsj.example.com/articles/hartwell-logistics-cuts-240-jobs',
        title: 'Hartwell Logistics cuts 240 jobs at Columbus hub',
      },
      {
        rank: 2,
        // Unwrapped from Google's /url?q=... redirect.
        url: 'https://jfs.ohio.example.gov/warn/public-notices/2026/hartwell.pdf',
        title: 'WARN notice — Hartwell Logistics LLC (PDF)',
      },
      {
        rank: 3,
        url: 'https://www.columbusdispatch.example.com/story/business/2026/10/02/hartwell-warn/',
        // HTML entities decoded.
        title: 'Hartwell & Sons files WARN notice ahead of Q4',
      },
    ]);
  });

  it('drops ads, People-also-ask and engine chrome', async () => {
    const page = await replayClient().serpResults(RECORDED_SERP_QUERY);
    const urls = page.results.map((r) => r.url);

    expect(urls).not.toContain('https://ads.example.net/click?id=99');
    expect(urls.some((u) => u.includes('google.com'))).toBe(false);
    expect(urls.some((u) => u.includes('support.google.com'))).toBe(false);
  });

  it('deduplicates a URL repeated further down the page', async () => {
    const page = await replayClient().serpResults(RECORDED_SERP_QUERY);
    expect(new Set(page.results.map((r) => r.url)).size).toBe(page.results.length);
  });
});

describe('parseSerpResults, shapes other than Google-s', () => {
  it("reads Bing's <h2><a> organic shape", () => {
    const html = `
      <ol id="b_results">
        <li class="b_algo"><h2>
          <a href="https://ohio.example.gov/filings/hartwell">Hartwell Logistics LLC filings</a>
        </h2><p>Entity details &amp; filing history</p></li>
        <li class="b_ad"><a href="https://ads.example.net/x">Ad: track layoffs</a></li>
      </ol>`;

    expect(parseSerpResults(html)).toEqual([
      {
        rank: 1,
        url: 'https://ohio.example.gov/filings/hartwell',
        title: 'Hartwell Logistics LLC filings',
      },
    ]);
  });

  it('returns an empty list rather than throwing on junk', () => {
    expect(parseSerpResults('')).toEqual([]);
    expect(parseSerpResults('<a href="not a url"><h3>No scheme</h3></a>')).toEqual([]);
    expect(parseSerpResults('<a href="https://x.example.com"><h3>   </h3></a>')).toEqual([]);
  });
});
