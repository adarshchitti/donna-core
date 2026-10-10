import { describe, it, expect } from 'vitest';
import { createBrightDataClient } from './client.js';
import {
  DEFAULT_GL,
  DEFAULT_HL,
  parseSerpHtml,
  parseSerpJson,
  parseSerpResults,
  serpPayloadKind,
  serpUrl,
} from './serp.js';
import { forbiddenFetch } from './testing.js';
import {
  CASSETTE_DIR,
  RECORDED_SERP_HTML_QUERY,
  RECORDED_SERP_JSON_OPTS,
  RECORDED_SERP_JSON_QUERY,
  pinnedNow,
} from './fixtures.test-util.js';

const replayClient = () =>
  createBrightDataClient({
    mode: 'replay',
    env: {},
    cassetteDir: CASSETTE_DIR,
    now: pinnedNow,
    fetchImpl: forbiddenFetch().impl,
  });

describe('serpUrl', () => {
  it('pins geo and language as URL params, defaulting to us/en', () => {
    expect(DEFAULT_GL).toBe('us');
    expect(DEFAULT_HL).toBe('en');
    expect(serpUrl('hartwell logistics layoffs')).toBe(
      'https://www.google.com/search?q=hartwell%20logistics%20layoffs&num=10&hl=en&gl=us',
    );
  });

  it('makes the country overridable per call', () => {
    expect(serpUrl('companies house filing', { gl: 'gb', hl: 'en' })).toBe(
      'https://www.google.com/search?q=companies%20house%20filing&num=10&hl=en&gl=gb',
    );
    // Case is normalised so two spellings cannot produce two cache entries.
    expect(serpUrl('x', { gl: 'US' })).toBe(serpUrl('x', { gl: 'us' }));
  });

  it('honours engine and num', () => {
    expect(serpUrl('warn notice', { engine: 'bing', num: 5 })).toBe(
      'https://www.bing.com/search?q=warn%20notice&count=5&setlang=en&cc=US',
    );
  });

  it('is deterministic, so the same query reuses the same cassette and cache entry', () => {
    expect(serpUrl('a b', { engine: 'google', num: 10, gl: 'us', hl: 'en' })).toBe(serpUrl('a b'));
  });
});

describe('serpPayloadKind', () => {
  it('tells JSON from markup', () => {
    expect(serpPayloadKind('{"organic":[]}')).toBe('json');
    expect(serpPayloadKind('\n  [1,2]')).toBe('json');
    expect(serpPayloadKind('<!doctype html><html>')).toBe('html');
    expect(serpPayloadKind('')).toBe('html');
  });
});

describe('parseSerpResults, against the real SERP-zone JSON cassette', () => {
  const page = async () => replayClient().serpResults(RECORDED_SERP_JSON_QUERY, RECORDED_SERP_JSON_OPTS);

  it('reads organic[] out of the parsed JSON the zone actually returns', async () => {
    const res = await page();

    expect(res.payload).toBe('json');
    expect(res.cache_hit).toBe(true);
    expect(res.credits_spent).toBe(0);
    expect(res.results).toHaveLength(9);
    expect(res.results[0]).toEqual({
      rank: 1,
      url:
        'https://www.employerlawreport.com/2016/03/articles/wage-hour/' +
        'assistant-managers-wage-hour-battle-with-bob-evans-farms-settled-for-16-5-million/',
      title: "Assistant managers' wage hour battle with Bob Evans ...",
      description:
        'Bob Evans Farms, Inc. the U.S. District Court in Columbus, Ohio ... ' +
        'layoff_WARN_Act Ohio employers, be WARNed: New Mini-WARN Law takes effect soon.',
    });
  });

  it('ranks 1..n with no holes, and every result has a URL and a title', async () => {
    const { results } = await page();

    expect(results.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(r.title.length).toBeGreaterThan(0);
    }
    expect(new Set(results.map((r) => r.url)).size).toBe(results.length);
  });

  it('carries the snippet, which is what a collector diffs on', async () => {
    const { results } = await page();
    expect(results.every((r) => typeof r.description === 'string')).toBe(true);
  });

  it('records a US-geo response, proving gl/hl travelled as URL params', async () => {
    const res = await page();
    const body = JSON.parse(res.body) as {
      general: { country_code: string; gl: string; language: string; search_engine: string };
    };

    // The live zone IGNORES a `country` field in the request body -- it returned
    // Argentina for one. These values come from the URL params instead.
    expect(body.general.country_code).toBe('US');
    expect(body.general.gl).toBe('US');
    expect(body.general.language).toBe('en');
    expect(body.general.search_engine).toBe('google');
  });

  it('ignores navigation, pagination and people_also_ask blocks', async () => {
    const res = await page();
    const body = JSON.parse(res.body) as Record<string, unknown>;

    // The API has already separated chrome from results, which is the whole
    // reason JSON beats scraping the HTML.
    expect(Object.keys(body)).toContain('navigation');
    expect(Object.keys(body)).toContain('people_also_ask');
    const urls = res.results.map((r) => r.url);
    expect(urls.some((u) => u.includes('google.com/search'))).toBe(false);
  });
});

describe('parseSerpJson', () => {
  it('prefers `link`, accepts `url`, and re-ranks after dropping bad rows', () => {
    const results = parseSerpJson({
      general: { search_engine: 'google' },
      organic: [
        { rank: 2, title: 'Second', link: 'https://b.example.com/' },
        { rank: 1, title: 'First', url: 'https://a.example.com/', description: 'snip' },
        { rank: 3, title: 'No link at all' },
        { rank: 4, link: 'https://c.example.com/' },
        { rank: 5, title: 'Not a URL', link: 'javascript:alert(1)' },
        { rank: 6, title: 'Dupe', link: 'https://a.example.com/' },
      ],
    });

    expect(results).toEqual([
      { rank: 1, title: 'First', url: 'https://a.example.com/', description: 'snip' },
      { rank: 2, title: 'Second', url: 'https://b.example.com/' },
    ]);
  });

  it('returns undefined for a payload that is not a SERP response', () => {
    expect(parseSerpJson({ hello: 'world' })).toBeUndefined();
    expect(parseSerpJson(null)).toBeUndefined();
    expect(parseSerpJson([1, 2, 3])).toBeUndefined();
  });

  it('tolerates unknown fields rather than failing a collector run', () => {
    const results = parseSerpJson({
      organic: [{ rank: 1, title: 'T', link: 'https://x.example.com/', brand_new_field: 42 }],
      some_block_added_next_month: { a: 1 },
    });
    expect(results).toEqual([{ rank: 1, title: 'T', url: 'https://x.example.com/' }]);
  });
});

describe('parseSerpResults dispatch', () => {
  it('falls back to HTML parsing for a markup payload', async () => {
    const res = await replayClient().serpResults(RECORDED_SERP_HTML_QUERY);

    expect(res.payload).toBe('html');
    expect(res.results.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(res.results[0]?.title).toBe('Hartwell Logistics cuts 240 jobs at Columbus hub');
  });

  it('falls back to HTML rather than throwing on malformed JSON', () => {
    expect(parseSerpResults('{"organic": [truncated')).toEqual([]);
  });

  it('falls back to HTML when JSON carries no organic block', () => {
    expect(parseSerpResults('{"general":{"query":"x"}}')).toEqual([]);
  });
});

describe('parseSerpHtml, the fallback path', () => {
  it('extracts organic result URLs and titles in rank order', async () => {
    const res = await replayClient().serp(RECORDED_SERP_HTML_QUERY);

    expect(parseSerpHtml(res.body)).toEqual([
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
    const res = await replayClient().serp(RECORDED_SERP_HTML_QUERY);
    const urls = parseSerpHtml(res.body).map((r) => r.url);

    expect(urls).not.toContain('https://ads.example.net/click?id=99');
    expect(urls.some((u) => u.includes('google.com'))).toBe(false);
    expect(urls.some((u) => u.includes('support.google.com'))).toBe(false);
  });

  it("reads Bing's <h2><a> organic shape", () => {
    const html = `
      <ol id="b_results">
        <li class="b_algo"><h2>
          <a href="https://ohio.example.gov/filings/hartwell">Hartwell Logistics LLC filings</a>
        </h2><p>Entity details &amp; filing history</p></li>
        <li class="b_ad"><a href="https://ads.example.net/x">Ad: track layoffs</a></li>
      </ol>`;

    expect(parseSerpHtml(html)).toEqual([
      {
        rank: 1,
        url: 'https://ohio.example.gov/filings/hartwell',
        title: 'Hartwell Logistics LLC filings',
      },
    ]);
  });

  it('returns an empty list rather than throwing on junk', () => {
    expect(parseSerpHtml('')).toEqual([]);
    expect(parseSerpHtml('<a href="not a url"><h3>No scheme</h3></a>')).toEqual([]);
    expect(parseSerpHtml('<a href="https://x.example.com"><h3>   </h3></a>')).toEqual([]);
  });
});
