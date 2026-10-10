/**
 * The per-source comparison table.
 *
 * Every source has its own notion of (a) what makes two records the SAME
 * record across two runs and (b) which of a record's fields carry observed
 * state. Those two notions are the whole of the diff, so they are expressed
 * as data here rather than as eight branches of a switch: adding a ninth
 * source is a row in this table, not a change to the diff algorithm.
 */
import type { Item, Source } from '@donna/contracts';
import { fieldValue, storyKey } from './normalise.js';

export interface ItemRule {
  /**
   * Fields that establish identity. Empty means "trust the collector's `key`",
   * which is correct for the singleton records (one status, one homepage) where
   * existence is not in question and only the value moves.
   */
  readonly identity: readonly string[];
  /**
   * Fields holding the record's observed state. A change in any of them is
   * `altered`. A change anywhere else is not reported at all -- a registry
   * page that reflows its HTML has not told us anything about the company.
   */
  readonly compared: readonly string[];
}

export interface SourceRule {
  /** Applied to any item whose `type` has no entry in `byType`. */
  readonly default: ItemRule;
  /** One source carries several kinds of record; `type` selects between them. */
  readonly byType?: Readonly<Record<string, ItemRule>>;
  /**
   * Folds many raw items into one logical item BEFORE identity is taken.
   * Only news needs this, and only because syndication is a property of the
   * press rather than of the company being watched.
   */
  readonly collapse?: (items: readonly Item[]) => Item[];
}

/**
 * One wire story, many outlet URLs, one item.
 *
 * A CFO resignation picked up by twelve outlets is one event. Diffing by URL
 * would emit twelve `added` changes, the validator would read twelve
 * independent `reported` corroborations of each other, and a single press
 * release would escalate itself to a confirmed finding. So the URLs are
 * folded down to one item per normalised headline, and the outlets we dropped
 * ride along on `also_seen_at` -- nothing is discarded, and breadth of pickup
 * stays available to the narrator as a fact about coverage.
 */
const collapseSyndicated = (items: readonly Item[]): Item[] => {
  const stories = new Map<string, { first: Item; urls: string[] }>();
  for (const item of items) {
    const key = storyKey(item);
    const url = fieldValue(item, 'url') || item.key;
    const seen = stories.get(key);
    if (seen === undefined) stories.set(key, { first: item, urls: [url] });
    else seen.urls.push(url);
  }
  return [...stories.entries()].map(([key, { first, urls }]) => ({
    ...first,
    // Written back so identity below can read one field for every news item,
    // whether or not the collector supplied it.
    headline_norm: key,
    also_seen_at: urls.slice(1).sort(),
  }));
};

export const SOURCE_RULES: Readonly<Record<Source, SourceRule>> = {
  /**
   * Officers by name+role: a registry that renumbers its officer rows has not
   * replaced its CFO, and an officer DISAPPEARING from the list is the
   * CFO-departure signal this whole system was built to catch, so it must fall
   * out of plain set difference and not depend on a status field existing.
   */
  registry: {
    // Unknown registry rows are treated as "a labelled field with a value",
    // which is the shape of nearly everything a registry publishes.
    default: { identity: [], compared: ['value'] },
    byType: {
      officer: { identity: ['name', 'role'], compared: [] },
      // Filings are append-only; a filing never changes once filed, so a new
      // filing id is the only thing a filing can tell us.
      filing: { identity: ['filing_id'], compared: [] },
      // Singletons: there is exactly one status and one address, so existence
      // is given and the VALUE is the state. 'active' -> 'dissolved' is
      // `altered`, never removed+added.
      status: { identity: [], compared: ['value'] },
      address: { identity: [], compared: ['value'] },
    },
  },

  /**
   * Cases by docket number -- the court's own identifier, stable for the life
   * of the case. A new docket is `added`. `status` is compared as well because
   * a case moving to judgment under the same docket is the event, and a source
   * that never publishes `status` compares equal on both sides for free.
   */
  court: {
    default: { identity: ['docket_number'], compared: ['status'] },
  },

  /** Actions, licences and sanctions all arrive under the regulator's own id. */
  regulator: {
    default: { identity: ['id'], compared: ['status'] },
  },

  /**
   * Notices by id. A notice's headcount is compared because WARN-style filings
   * get revised upward in place, and 50 becoming 400 under one id is the news.
   */
  layoffs: {
    default: { identity: ['id'], compared: ['employees_affected', 'effective_date'] },
  },

  /** Articles by URL, collapsed to one item per normalised headline first. */
  news: {
    default: { identity: ['headline_norm'], compared: [] },
    collapse: collapseSyndicated,
  },

  /**
   * A move is a person, a role and a date; the same person moving twice is two
   * moves. All three are identity, so a move is only ever added or removed --
   * a move whose details were restated is a different move, not an amended one.
   */
  executives: {
    default: { identity: ['person', 'role', 'date'], compared: [] },
  },

  jobs: {
    default: { identity: [], compared: ['value'] },
    byType: {
      // One count row (`jobs:count`) per run, so the DELTA is the signal: this
      // emits `altered` carrying the old count rather than a remove/add pair,
      // which is what lets a briefing say "12 open roles, down from 28".
      job_count: { identity: [], compared: ['open_roles'] },
      // Titles are a set; a title appearing or disappearing IS the change.
      job_title: { identity: ['title'], compared: [] },
    },
  },

  domain: {
    default: { identity: [], compared: ['value'] },
    byType: {
      // WHOIS field by field: a registrar change and a nameserver change are
      // two observations with different meanings, not one "whois changed".
      whois_field: { identity: ['field'], compared: ['value'] },
      // The content hash is the authority on whether the page moved. `title`
      // is deliberately NOT compared -- it rides along on the item so that
      // `previous.title` still carries the title diff when the hash changes,
      // without a cosmetic retitle under an unchanged hash counting as change.
      homepage: { identity: [], compared: ['content_hash'] },
    },
  },
};

/** The rule governing one item. `type` selects it; the source's default backs it. */
export const ruleFor = (source: Source, item: Item): ItemRule => {
  const rule = SOURCE_RULES[source];
  return rule.byType?.[item.type] ?? rule.default;
};

const SEP = '\u0000';

/**
 * The cross-run identity of one item.
 *
 * `type` prefixes every identity, which does two jobs: an officer and a filing
 * that happen to share an id can never be mistaken for one record, and a
 * matched pair is guaranteed to resolve to the SAME ItemRule -- so comparing
 * their state below is always a like-for-like comparison.
 */
export const identityOf = (source: Source, item: Item): string => {
  const { identity } = ruleFor(source, item);
  const parts = identity.map((field) => fieldValue(item, field));
  // A rule whose identity fields are all absent would otherwise fold every
  // such item onto one identity. Fall back to the collector's key, which the
  // contract already guarantees is present and non-empty.
  if (parts.length === 0 || parts.every((part) => part === '')) {
    return `${item.type}${SEP}${item.key}`;
  }
  return `${item.type}${SEP}${parts.join(SEP)}`;
};

/**
 * The observed state of one item, as a single comparable string.
 *
 * A source with no compared fields yields '' for every item, so identity
 * matching alone decides added/removed and nothing is ever `altered`. That is
 * the right answer for append-only records such as court filings.
 */
export const stateOf = (source: Source, item: Item): string =>
  ruleFor(source, item).compared.map((field) => fieldValue(item, field)).join(SEP);

/**
 * Collapse (where the source asks for it) and index by identity.
 *
 * Two items sharing one identity inside a single snapshot is a collector bug,
 * not a change, so the first wins and the rest are dropped rather than being
 * diffed against each other into a phantom alteration.
 */
export const indexItems = (source: Source, items: readonly Item[]): Map<string, Item> => {
  const collapse = SOURCE_RULES[source].collapse;
  const prepared = collapse ? collapse(items) : items;
  const byIdentity = new Map<string, Item>();
  for (const item of prepared) {
    const id = identityOf(source, item);
    if (!byIdentity.has(id)) byIdentity.set(id, item);
  }
  return byIdentity;
};
