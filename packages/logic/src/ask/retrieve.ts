import { SOURCE_LABELS, type CollectorRun, type Source } from '@donna/contracts';
import { toNarratorView } from '../narrator/types.js';
import type { AskCandidates, AskInput, AskIntent } from './types.js';

/**
 * RETRIEVAL. Deterministic, and deliberately simple.
 *
 * The model never searches. This file decides which records are candidates for
 * the answer: a keyword prefilter over stored records, plus structured filters
 * for the intents a keyword match would get wrong (verdicts, coverage, watched
 * terms). Whatever survives becomes the ENTIRE world the model can cite -- a
 * record that is not a candidate cannot be referenced, which is the mechanism
 * that keeps the model from importing a counterparty fact from nowhere.
 */

const MAX_SIGNALS = 12;
const MAX_DEALS = 5;
const MAX_RUNS = 10;

// ---------------------------------------------------------------------------
// Intent classification. Order matters: a verdict word outranks everything
// else, because "is it safe to renew given the court filing?" is a verdict
// question wearing a records question's clothes.
// ---------------------------------------------------------------------------

/**
 * Verdict asks. The product reports records; it does not certify and does not
 * advise, so "healthy", "safe", "should I" route to refusal + observations.
 * "renew" alone is not here -- "when does the contract renew?" is a records
 * question -- only renewal phrased as a decision.
 */
const VERDICT_RE =
  /\b(healthy|healthier|healthiest|good\s+standing|safe|safely|safer|low[\s-]risk|risky|should\s+(?:i|we)|shall\s+(?:i|we)|worth\s+(?:it|renewing|signing)|safe\s+to\s+(?:renew|sign)|renew\s+it|can\s+(?:i|we)\s+trust|are\s+they\s+(?:reliable|ok(?:ay)?|fine|good|legit|legitimate|trustworthy)|trustworthy|recommend)\b/i;

const COVERAGE_RE =
  /\b(coverage|covered|covering|(?:what\s+)?(?:do|did|have)\s+you\s+(?:check|cover|monitor|watch|look)|which\s+sources?|sources?\s+(?:do|did|have)\s+you|did\s+you\s+(?:check|look|monitor|fetch)|(?:was|were|is|are)\s+\w*\s*(?:checked|monitored|fetched|reachable|unreachable)|monitor(?:ing|ed)?\s+(?:them|this|it|the\s+compan|sources?)|how\s+fresh|how\s+often\s+(?:do|did)\s+you|when\s+(?:did|was|were).*(?:checked|fetched|monitored|run))\b/i;

const WATCHED_TERMS_RE =
  /\b(terms?|watched|breach(?:es|ed|ing)?|violat(?:e|ed|es|ion|ing)|covenant|clause|contractual|notice\s+(?:period|clause|term)|key\s+person|non[\s-]?compete|change.of.control\s+(?:clause|term)|contract\s*(?:break|issue|problem)?)\b/i;

/** A question that asks for "everything" rather than a specific fact. */
const BROAD_RE =
  /\b(everything|anything|all|overall|general|summary|summarise|summarize|overview|latest|recent|recently|new|news\s+on|what\s+(?:happened|changed|is\s+new)|going\s+on|up\s+to|know\s+about|tell\s+me|show\s+me|give\s+me|status|update)\b/i;

export const classifyIntent = (question: string): AskIntent => {
  if (VERDICT_RE.test(question)) return 'verdict';
  if (COVERAGE_RE.test(question)) return 'coverage';
  if (WATCHED_TERMS_RE.test(question)) return 'watched_terms';
  return 'records';
};

// ---------------------------------------------------------------------------
// Tokenisation and scoring.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at',
  'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it',
  'its', 'this', 'that', 'these', 'those', 'they', 'them', 'their', 'there',
  'we', 'our', 'us', 'i', 'me', 'my', 'you', 'your', 'he', 'she', 'his', 'her',
  'do', 'does', 'did', 'done', 'have', 'has', 'had', 'having', 'can', 'could',
  'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'not', 'no',
  'if', 'then', 'than', 'so', 'such', 'what', 'which', 'who', 'whom', 'whose',
  'when', 'where', 'why', 'how', 'about', 'into', 'over', 'under', 'again',
  'any', 'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'only',
  'own', 'same', 'too', 'very', 'just', 'now', 'tell', 'show', 'give', 'me',
  'please', 'company', 'companies', 'counterparty', 'say', 'said', 'get',
  'got', 'really', 'actually', 'don', 'didn', 'doesn', 'isn', 'aren', 'won',
]);

const tokens = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

const contentTokens = (s: string): Set<string> =>
  new Set(tokens(s).filter((t) => t.length > 1 && !STOPWORDS.has(t)));

/**
 * Loose synonym expansion on the QUESTION side, so "lawsuit" reaches a signal
 * of type `litigation` and "bankrupt" reaches `insolvency`. Deliberately small:
 * this is a prefilter, not a taxonomy.
 */
const SYNONYMS: Record<string, string[]> = {
  bankrupt: ['insolvency', 'distress'],
  bankruptcy: ['insolvency', 'distress'],
  insolvent: ['insolvency', 'distress'],
  winding: ['insolvency'],
  liquidated: ['insolvency'],
  lawsuit: ['litigation', 'court'],
  sued: ['litigation', 'court'],
  suing: ['litigation', 'court'],
  legal: ['litigation', 'court', 'enforcement'],
  court: ['litigation', 'court'],
  fired: ['exec', 'departure', 'officer'],
  departed: ['exec', 'departure', 'officer'],
  quit: ['exec', 'departure', 'officer'],
  left: ['exec', 'departure', 'officer'],
  ceo: ['exec', 'officer', 'executive'],
  cfo: ['exec', 'officer', 'executive'],
  executive: ['exec', 'officer', 'executive'],
  executives: ['exec', 'officer', 'executive'],
  officer: ['exec', 'officer'],
  officers: ['exec', 'officer'],
  director: ['exec', 'officer', 'director'],
  directors: ['exec', 'officer', 'director'],
  leadership: ['exec', 'officer', 'management'],
  management: ['exec', 'officer', 'management'],
  hired: ['exec', 'appointment', 'officer', 'job'],
  hiring: ['job', 'postings'],
  jobs: ['job', 'postings'],
  layoffs: ['layoff'],
  redundancy: ['layoff'],
  redundancies: ['layoff'],
  owner: ['change', 'control', 'ownership'],
  owners: ['change', 'control', 'ownership'],
  ownership: ['change', 'control', 'ownership'],
  bought: ['change', 'control', 'acquired'],
  sold: ['change', 'control', 'acquired'],
  acquired: ['change', 'control', 'acquired'],
  acquisition: ['change', 'control', 'acquired'],
  merger: ['change', 'control'],
  website: ['domain', 'site'],
  site: ['domain', 'site'],
  sanctions: ['sanctions', 'sanction'],
  sanctioned: ['sanctions', 'sanction'],
  regulator: ['regulator', 'enforcement'],
  regulatory: ['regulator', 'enforcement'],
  fine: ['enforcement', 'penalty'],
  fined: ['enforcement', 'penalty'],
  license: ['licence'],
  licensed: ['licence'],
  permit: ['licence'],
  press: ['news', 'press'],
  media: ['news', 'press'],
  address: ['address'],
  moved: ['address', 'change', 'control'],
  hq: ['address', 'headquarters'],
  headquarters: ['address', 'headquarters'],
  changed: ['change'],
  changes: ['change'],
  update: ['change'],
  payment: ['payment', 'behaviour'],
  payments: ['payment', 'behaviour'],
  paying: ['payment', 'behaviour'],
  paid: ['payment', 'behaviour'],
  credit: ['credit', 'financials'],
  rating: ['credit', 'rating'],
  renewal: ['renewal', 'end'],
  renew: ['renewal', 'end'],
  renews: ['renewal', 'end'],
  expire: ['renewal', 'end'],
  expires: ['renewal', 'end'],
  expiry: ['renewal', 'end'],
  contract: ['agreement', 'terms'],
  contracts: ['agreement', 'terms'],
  agreement: ['agreement'],
};

const expandedQueryTokens = (question: string): Set<string> => {
  const out = contentTokens(question);
  for (const t of [...out]) {
    for (const syn of SYNONYMS[t] ?? []) out.add(syn);
  }
  return out;
};

/**
 * The scored text of a signal. `company_id` is deliberately absent: company
 * matching is the scope's job, and including it here would score every signal
 * of a named company ≥1, which is a scope answer disguised as relevance.
 */
const signalText = (s: {
  type: string;
  title: string;
  summary_fact: string;
  touches_terms: readonly string[];
}): Set<string> =>
  new Set([
    ...tokens(s.type.replace(/_/g, ' ')),
    ...tokens(s.title),
    ...tokens(s.summary_fact),
    ...s.touches_terms.flatMap((t) => tokens(t)),
  ]);

// ---------------------------------------------------------------------------
// Company scope. The input may be book-wide; a question that names a company
// must only see that company's records. Detection is token overlap between the
// question and each company's identifying tokens (company_id parts + deal
// counterparty names). Company-stop tokens ("llc", "holdings") are excluded so
// "Nordvale Industrial LLC" scopes on "nordvale"/"industrial", not "llc".
// ---------------------------------------------------------------------------

const GENERIC_COMPANY_TOKENS = new Set([
  'llc', 'inc', 'ltd', 'co', 'corp', 'corporation', 'company', 'group',
  'holdings', 'holding', 'lp', 'llp', 'plc', 'gmbh', 'sarl', 'pty', 'bv',
  'limited', 'incorporated', 'intl', 'international', 'global',
]);

const companyTokens = (text: string): Set<string> =>
  new Set(tokens(text).filter((t) => t.length > 2 && !GENERIC_COMPANY_TOKENS.has(t)));

export interface CompanyScope {
  /** Companies named in the question. Null means the question is book-wide. */
  scoped: readonly string[] | null;
  /** Deal ids whose counterparty name the question names (deals may lack company_id). */
  named_deal_ids: readonly string[];
}

export const detectCompanyScope = (
  question: string,
  input: AskInput,
): CompanyScope => {
  const qTokens = new Set(tokens(question));
  const profiles = new Map<string, Set<string>>();
  const profile = (id: string): Set<string> => {
    let p = profiles.get(id);
    if (p === undefined) {
      p = companyTokens(id);
      profiles.set(id, p);
    }
    return p;
  };

  for (const s of input.signals) profile(s.company_id);
  for (const r of input.runs) profile(r.company_id);
  for (const d of input.deals) {
    if (d.company_id !== undefined) {
      const p = profile(d.company_id);
      for (const t of companyTokens(d.counterparty_name)) p.add(t);
    }
  }

  const scoped = [...profiles.entries()]
    .filter(([, toks]) => [...toks].some((t) => qTokens.has(t)))
    .map(([id]) => id);

  // Deals without company_id can still be named directly.
  const namedDealIds = input.deals
    .filter((d) => d.company_id === undefined)
    .filter((d) => [...companyTokens(d.counterparty_name)].some((t) => qTokens.has(t)))
    .map((d) => d.deal_id);

  return {
    scoped: scoped.length > 0 ? scoped : null,
    named_deal_ids: namedDealIds,
  };
};

// ---------------------------------------------------------------------------
// Candidate selection, per intent.
// ---------------------------------------------------------------------------

const byTierThenRecency = <T extends { tier: number; first_seen: string }>(a: T, b: T): number =>
  a.tier - b.tier || b.first_seen.localeCompare(a.first_seen);

const score = (haystack: Set<string>, qTokens: Set<string>): number => {
  let n = 0;
  for (const t of qTokens) if (haystack.has(t)) n += 1;
  return n;
};

const inScope = (companyId: string, scoped: readonly string[] | null): boolean =>
  scoped === null || scoped.includes(companyId);

export const retrieveCandidates = (
  input: AskInput,
  intent: AskIntent,
  scope: CompanyScope,
): AskCandidates => {
  const { scoped } = scope;
  const qTokens = expandedQueryTokens(input.question);
  const namedDeals = new Set(scope.named_deal_ids);

  const scopedSignals = input.signals.filter((s) => inScope(s.company_id, scoped));
  const scopedDeals = input.deals.filter(
    (d) => namedDeals.has(d.deal_id) || (d.company_id !== undefined && inScope(d.company_id, scoped)),
  );
  const scopedRuns = input.runs.filter((r) => inScope(r.company_id, scoped));

  const scoredSignals = scopedSignals
    .map((s) => ({ s, n: score(signalText(s), qTokens) }))
    .sort((a, b) => b.n - a.n || byTierThenRecency(a.s, b.s));

  const scoredDeals = scopedDeals
    .map((d) => ({
      d,
      n:
        namedDeals.has(d.deal_id) ? Number.MAX_SAFE_INTEGER :
        // counterparty_name is deliberately not scored: it is the company's
        // name, and company matching is the scope's job, not relevance's.
        score(
          new Set([
            ...tokens(d.deal_class.replace(/_/g, ' ')),
            ...tokens(d.watch_terms ?? ''),
            ...tokens(d.status),
          ]),
          qTokens,
        ),
    }))
    .sort((a, b) => b.n - a.n);

  let signals = scoredSignals.filter((x) => x.n > 0).map((x) => x.s);
  let deals = scoredDeals.filter((x) => x.n > 0).map((x) => x.d);
  let runs: CollectorRun[] = [];
  const coverage = input.coverage;

  switch (intent) {
    case 'verdict': {
      // A verdict question is about the company generally: show what is
      // observed, all of it, not just keyword matches.
      signals = scopedSignals.sort(byTierThenRecency);
      deals = scopedDeals;
      break;
    }
    case 'coverage': {
      // Coverage is a statement about what WE did: runs and coverage records,
      // not signals. A few top signals ride along only as answer context.
      runs = scopedRuns.slice(0, MAX_RUNS);
      signals = scoredSignals.slice(0, 3).map((x) => x.s);
      deals = [];
      break;
    }
    case 'watched_terms': {
      // Structured filter, not keywords: the records that can answer are the
      // signals that touch a watched term and the deals that carry them.
      signals = scopedSignals
        .filter((s) => s.touches_terms.length > 0)
        .sort(byTierThenRecency);
      deals = scopedDeals.filter(
        (d) => namedDeals.has(d.deal_id) || (d.watch_terms ?? '') !== '',
      );
      break;
    }
    case 'records': {
      // Broad phrasing ("tell me everything") widens the net ONLY when the
      // keywords found nothing; a question that names a topic selects on it.
      if (signals.length === 0 && BROAD_RE.test(input.question)) {
        signals = scopedSignals.sort(byTierThenRecency);
      }
      if (deals.length === 0 && BROAD_RE.test(input.question)) {
        deals = scoredDeals.slice(0, 3).map((x) => x.d);
      }
      break;
    }
  }

  return {
    signals: signals.slice(0, MAX_SIGNALS).map(toNarratorView),
    deals: deals.slice(0, MAX_DEALS),
    coverage,
    runs: runs.slice(0, MAX_RUNS),
    scoped_company_ids: scoped,
  };
};

// ---------------------------------------------------------------------------
// The noun phrase a "not observed" answer names. Keeps the honest sentence
// specific: "A credit rating is not observed..." reads as an answer, not a
// shrug.
// ---------------------------------------------------------------------------

const TOPICS: [RegExp, string][] = [
  [/\bcredit\s*(?:rating|score|worth|worthiness)|creditworthy/i, 'A credit rating'],
  [/\bbankrupt|insolven|winding|liquidat|administration\b/i, 'Insolvency or distress'],
  [/\blawsuit|litigation|sued|suing|legal\s+action|court\s+case|claim\b/i, 'Litigation'],
  [/\blay\s*offs?|redundan|headcount\s*cut|job\s*cuts?/i, 'Layoffs'],
  [/\bofficers?|executives?|directors?|ceo|cfo|leadership|management\b/i, 'Officer changes'],
  [/\bpayments?|paying|paid|invoice|late\s+pay/i, 'Payment behaviour'],
  [/\bowner(?:ship)?|change\s+of\s+control|acqui|merger|bought|sold\b/i, 'Ownership changes'],
  [/\bsanction/i, 'Sanctions matches'],
  [/\blicen[cs]e|permit/i, 'Licence status'],
  [/\bnews|press|media\b/i, 'Press coverage'],
  [/\bdomain|website|web\s*site\b/i, 'Domain changes'],
  [/\baddress|headquarters|\bhq\b/i, 'Address changes'],
  [/\bhiring|job\s+postings?|open\s+roles?|recruit/i, 'Hiring'],
  [/\bfinancials?|revenue|profit|earnings/i, 'Private financials'],
];

export const questionTopic = (question: string): string => {
  for (const [re, phrase] of TOPICS) {
    if (re.test(question)) return phrase;
  }
  return 'That';
};

/** Human labels for the checked/failed source ids, for coverage lines. */
export const sourceNames = (ids: readonly string[]): string[] =>
  ids.map((id) => SOURCE_LABELS[id as Source] ?? id);
