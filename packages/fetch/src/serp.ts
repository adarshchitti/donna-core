/**
 * SERP URL construction and organic-result parsing.
 *
 * Why parse at all: collectors must do "SERP first, page fetch only for new
 * result URLs". One SERP call that yields ten candidate URLs is one credit;
 * unlocking all ten is ten. So the parser is a credit-saving device -- it lets
 * a collector diff result URLs against what it already has and unlock only the
 * genuinely new ones.
 */

import { z } from 'zod';
import type { SerpEngine, SerpOptions, SerpPayloadKind, SerpResult } from './types.js';

const DEFAULT_NUM = 10;
/** Every company Donna watches is American; an unpinned geo returns Egypt. */
export const DEFAULT_GL = 'us';
export const DEFAULT_HL = 'en';

/**
 * The `url` Bright Data's SERP zone takes is an ordinary search-engine URL;
 * the zone is what makes it a SERP request rather than a page fetch.
 *
 * Geo lives HERE, in the query string, and nowhere else: a `country` field in
 * the request body is ignored by the zone (verified live -- it returned
 * `country_code: "AR"` for `country: "us"`, and `"EG"` with no `gl`). `gl` and
 * `hl` as URL params correctly yield `country_code: "US"`.
 *
 * Params are emitted in a fixed order so the same query always produces the
 * same URL, and therefore the same cache key and the same cassette, on any
 * machine.
 */
export const serpUrl = (query: string, opts: SerpOptions = {}): string => {
  const engine: SerpEngine = opts.engine ?? 'google';
  const num = opts.num ?? DEFAULT_NUM;
  const gl = (opts.gl ?? DEFAULT_GL).toLowerCase();
  const hl = (opts.hl ?? DEFAULT_HL).toLowerCase();
  const q = encodeURIComponent(query);
  return engine === 'bing'
    ? `https://www.bing.com/search?q=${q}&count=${num}&setlang=${hl}&cc=${gl.toUpperCase()}`
    : `https://www.google.com/search?q=${q}&num=${num}&hl=${hl}&gl=${gl}`;
};

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

const decodeEntities = (s: string): string =>
  s
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));

const stripTags = (s: string): string => s.replace(/<[^>]*>/g, '');

const textOf = (html: string): string => decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim();

/** Hosts whose links are chrome (nav, tools, cached copies), never a result. */
const CHROME_HOST = /(^|\.)(google|bing|googleusercontent|microsofttranslator)\.[a-z.]+$/i;

/**
 * Google often wraps a result in `/url?q=<target>&sa=...`; Bing uses direct
 * hrefs. Return the real target, or undefined if this is not a result link.
 */
const normalizeHref = (href: string): string | undefined => {
  let raw = decodeEntities(href).trim();
  if (raw.startsWith('/url?') || raw.startsWith('/interstitial?')) {
    const target = new URLSearchParams(raw.slice(raw.indexOf('?') + 1)).get('q') ?? undefined;
    if (target === undefined) return undefined;
    raw = target;
  }
  if (!/^https?:\/\//i.test(raw)) return undefined;
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return undefined;
  }
  return CHROME_HOST.test(host) ? undefined : raw;
};

// Anchors, non-greedily to their closing tag. Good enough for SERP HTML and it
// cannot throw on malformed markup, which a DOM parser dependency would be
// overkill to avoid.
const ANCHOR = /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
// Google titles results with <h3>, Bing with <h2>. Anything else is chrome.
const HEADING = /<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i;

/**
 * Extract organic result URLs + titles from SERP HTML.
 *
 * This is the FALLBACK path: the SERP zone returns JSON by default, and we
 * standardise on it. HTML parsing stays for anything that arrives as markup
 * (a `data_format: "html"` call, an old cassette, a page the unlocker fetched).
 *
 * Deliberately conservative: a link only counts as a result if it wraps (or is
 * wrapped by) a heading, which is how both engines mark organic results. Ads,
 * "People also ask" and footer navigation carry no heading and drop out.
 * Deduplicated by URL, keeping the first (highest-ranked) occurrence.
 */
export const parseSerpHtml = (html: string): SerpResult[] => {
  const out: SerpResult[] = [];
  const seen = new Set<string>();

  // Case 1: <a href=".."><h3>Title</h3></a>  (Google's shape)
  for (const m of html.matchAll(ANCHOR)) {
    const href = m[1];
    const inner = m[2];
    if (href === undefined || inner === undefined) continue;
    const heading = HEADING.exec(inner);
    if (heading?.[1] === undefined) continue;
    const url = normalizeHref(href);
    const title = textOf(heading[1]);
    if (url === undefined || title === '' || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title, rank: out.length + 1 });
  }

  // Case 2: <h2><a href="..">Title</a></h2>  (Bing's shape, and Google's
  // "news" blocks). Scanned second so Google's ranking order wins on overlap.
  for (const m of html.matchAll(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/gi)) {
    const inner = m[1];
    if (inner === undefined) continue;
    const anchor = /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(inner);
    if (anchor?.[1] === undefined || anchor[2] === undefined) continue;
    const url = normalizeHref(anchor[1]);
    const title = textOf(anchor[2]);
    if (url === undefined || title === '' || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title, rank: out.length + 1 });
  }

  return out;
};

// ---------------------------------------------------------------------------
// JSON payloads -- the primary path.
// ---------------------------------------------------------------------------

/**
 * The slice of the SERP API's parsed response we rely on.
 *
 * Validated loosely and `passthrough()`-ed on purpose: Bright Data adds fields
 * to these objects without notice, and a strict schema would turn a harmless
 * new key into a failed collector run. We assert only what we read.
 */
export const serpOrganicSchema = z
  .object({
    title: z.string().optional(),
    /** The API uses `link`; some result blocks use `url`. Accept either. */
    link: z.string().optional(),
    url: z.string().optional(),
    rank: z.number().optional(),
    description: z.string().optional(),
  })
  .passthrough();

export const serpJsonSchema = z
  .object({
    general: z
      .object({
        search_engine: z.string().optional(),
        query: z.string().optional(),
        results_cnt: z.number().optional(),
        country_code: z.string().optional(),
        language: z.string().optional(),
      })
      .passthrough()
      .optional(),
    organic: z.array(serpOrganicSchema).optional(),
  })
  .passthrough();
export type SerpJson = z.infer<typeof serpJsonSchema>;

const isHttpUrl = (s: string): boolean => /^https?:\/\//i.test(s);

/**
 * Pull organic results out of an already-parsed SERP JSON payload.
 *
 * Only `organic[]` is read. `navigation[]` is engine chrome and the other
 * blocks are not organic results, which is the whole advantage of the JSON
 * shape over scraping HTML: the API has already done that separation.
 *
 * Returns undefined when this is not a SERP JSON payload at all, so the caller
 * can fall back to HTML rather than silently reporting zero results.
 */
export const parseSerpJson = (payload: unknown): SerpResult[] | undefined => {
  const parsed = serpJsonSchema.safeParse(payload);
  if (!parsed.success || parsed.data.organic === undefined) return undefined;

  // Trust the API's own ranking, but sort defensively: array order has been the
  // rank order in every response we have seen, and `rank` makes that explicit.
  const rows = [...parsed.data.organic].sort(
    (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
  );

  const out: SerpResult[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const url = row.link ?? row.url;
    const title = row.title?.trim();
    if (url === undefined || !isHttpUrl(url) || title === undefined || title === '') continue;
    if (seen.has(url)) continue;
    seen.add(url);
    // Re-ranked 1..n after filtering, so `rank` has one meaning everywhere and
    // never has holes where a malformed row was dropped.
    const result: SerpResult = { url, title, rank: out.length + 1 };
    if (row.description !== undefined) result.description = row.description;
    out.push(result);
  }
  return out;
};

/** Does this payload look like JSON rather than markup? */
export const serpPayloadKind = (payload: string): SerpPayloadKind => {
  const head = payload.trimStart()[0];
  return head === '{' || head === '[' ? 'json' : 'html';
};

/**
 * Extract organic results from whatever the SERP zone returned.
 *
 * JSON first, because that is what the zone returns by default (even with
 * `format: "raw"`); HTML as a fallback. One function, one uniform
 * `SerpResult[]`, so a collector never has to know which shape it got.
 */
export const parseSerpResults = (payload: string): SerpResult[] => {
  if (serpPayloadKind(payload) === 'json') {
    try {
      const results = parseSerpJson(JSON.parse(payload) as unknown);
      if (results !== undefined) return results;
    } catch {
      // Malformed JSON, or JSON with no `organic`: fall through to HTML rather
      // than throw. A collector gets zero results, not a crashed run.
    }
  }
  return parseSerpHtml(payload);
};
