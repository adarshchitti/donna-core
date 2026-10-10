/**
 * SERP URL construction and organic-result parsing.
 *
 * Why parse at all: collectors must do "SERP first, page fetch only for new
 * result URLs". One SERP call that yields ten candidate URLs is one credit;
 * unlocking all ten is ten. So the parser is a credit-saving device -- it lets
 * a collector diff result URLs against what it already has and unlock only the
 * genuinely new ones.
 */

import type { SerpEngine, SerpOptions, SerpResult } from './types.js';

const DEFAULT_NUM = 10;

/**
 * The `url` Bright Data's SERP zone takes is an ordinary search-engine URL;
 * the zone is what makes it a SERP request rather than a page fetch.
 */
export const serpUrl = (query: string, opts: SerpOptions = {}): string => {
  const engine: SerpEngine = opts.engine ?? 'google';
  const num = opts.num ?? DEFAULT_NUM;
  const q = encodeURIComponent(query);
  // hl/gl are pinned so the same query produces the same URL -- and therefore
  // the same cache key and the same cassette -- from any machine.
  return engine === 'bing'
    ? `https://www.bing.com/search?q=${q}&count=${num}&setlang=en`
    : `https://www.google.com/search?q=${q}&num=${num}&hl=en&gl=us`;
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
 * Deliberately conservative: a link only counts as a result if it wraps (or is
 * wrapped by) a heading, which is how both engines mark organic results. Ads,
 * "People also ask" and footer navigation carry no heading and drop out.
 * Deduplicated by URL, keeping the first (highest-ranked) occurrence.
 */
export const parseSerpResults = (html: string): SerpResult[] => {
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
