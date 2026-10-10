import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Change, Item, Snapshot } from '@donna/contracts';
import { changeSchema, snapshotSchema } from '@donna/contracts';
import { advanceBaselines, latestOkSnapshot } from './baseline.js';
import { diffSnapshot, outcomeOf } from './diff.js';
import { identityOf, SOURCE_RULES } from './sources.js';
import { normaliseHeadline } from './normalise.js';

/**
 * Hand-written snapshot pairs. Parsing them through `snapshotSchema` means a
 * fixture that drifts from the contract fails here rather than producing a
 * differ test that passes against a shape nothing else in the system writes.
 */
const load = (name: string): Snapshot => {
  const url = new URL(`../../../../fixtures/snapshots/${name}.json`, import.meta.url);
  return snapshotSchema.parse(JSON.parse(readFileSync(url, 'utf8')));
};

const OPTS = { bookId: 'book-demo', detectedAt: '2026-10-10T06:05:00Z' } as const;

/** The same page fetched again, unchanged: a new run id, identical items. */
const refetch = (snapshot: Snapshot): Snapshot => ({
  ...snapshot,
  snapshot_id: `${snapshot.snapshot_id}-refetch`,
  fetched_at: '2026-10-10T06:00:00Z',
});

const only = <T>(xs: readonly T[]): T => {
  expect(xs).toHaveLength(1);
  return xs[0]!;
};

const field = (item: Item | null, name: string): unknown => item?.[name];

/** Every change any test in this file produced, re-validated at the end. */
const allEmitted: Change[] = [];
const record = (changes: Change[]): Change[] => {
  allEmitted.push(...changes);
  return changes;
};

const diff = (nextName: string, baselineName: string | null): ReturnType<typeof diffSnapshot> => {
  const result = diffSnapshot(load(nextName), baselineName === null ? null : load(baselineName), OPTS);
  record(result.changes);
  return result;
};

// ---------------------------------------------------------------------------
// Rule 1. The one that matters most.
// ---------------------------------------------------------------------------
describe('Rule 1: the first run is a baseline, never an alert', () => {
  it('emits ZERO changes when there is no baseline', () => {
    const result = diff('registry.baseline', null);
    expect(result.changes).toEqual([]);
    expect(result.isFirstRun).toBe(true);
  });

  it('returns the items as the starting state for the next run', () => {
    const next = load('registry.baseline');
    const result = diffSnapshot(next, null, OPTS);
    expect(result.baselineItems).toHaveLength(next.items.length);
  });

  it('holds for every source, including the loud ones', () => {
    for (const name of [
      'court.new-docket', 'layoffs.new-notice', 'news.syndicated',
      'regulator.licence-revoked', 'jobs.count-dropped', 'domain.homepage-changed',
      'executives.new-move',
    ]) {
      const result = diffSnapshot(load(name), null, OPTS);
      expect(result.changes, `${name} must stay silent on a first run`).toEqual([]);
      expect(result.isFirstRun).toBe(true);
    }
  });

  it('reports `baseline`, which is not the same outcome as `unchanged`', () => {
    const first = diffSnapshot(load('registry.baseline'), null, OPTS);
    const quiet = diffSnapshot(refetch(load('registry.baseline')), load('registry.baseline'), OPTS);
    expect(outcomeOf(first)).toBe('baseline');
    expect(outcomeOf(quiet)).toBe('unchanged');
    expect(first.isFirstRun).not.toBe(quiet.isFirstRun);
  });
});

// ---------------------------------------------------------------------------
// Rule 4. Silence is a result.
// ---------------------------------------------------------------------------
describe('Rule 4: a run with no changes is a normal outcome', () => {
  it('a second run over identical items emits nothing and is not a first run', () => {
    const baseline = load('registry.baseline');
    const result = diffSnapshot(refetch(baseline), baseline, OPTS);
    expect(result.changes).toEqual([]);
    expect(result.isFirstRun).toBe(false);
    expect(outcomeOf(result)).toBe('unchanged');
  });

  it('stays silent across every source when nothing moved', () => {
    for (const name of [
      'registry.baseline', 'court.baseline', 'news.baseline', 'jobs.baseline',
      'domain.baseline', 'executives.baseline', 'regulator.baseline', 'layoffs.baseline',
    ]) {
      const baseline = load(name);
      const result = diffSnapshot(refetch(baseline), baseline, OPTS);
      expect(result.changes, `${name} invented a change out of an identical refetch`).toEqual([]);
      expect(outcomeOf(result)).toBe('unchanged');
    }
  });
});

// ---------------------------------------------------------------------------
// Rule 2. Per-source identity and per-source "altered".
// ---------------------------------------------------------------------------
describe('registry', () => {
  it('an officer leaving the list is exactly one `removed`', () => {
    const result = diff('registry.officer-removed', 'registry.baseline');
    const change = only(result.changes);
    expect(change.kind).toBe('removed');
    expect(change.item.type).toBe('officer');
    expect(field(change.item, 'name')).toBe('Jane Doe');
    expect(field(change.item, 'role')).toBe('CFO');
    // `previous` holds the last observed state for every kind, so a consumer
    // never has to pick a different field depending on `kind`.
    expect(field(change.previous, 'name')).toBe('Jane Doe');
  });

  it('a status value change is one `altered` carrying `previous`', () => {
    const result = diff('registry.status-changed', 'registry.baseline');
    const change = only(result.changes);
    expect(change.kind).toBe('altered');
    expect(field(change.item, 'value')).toBe('administratively dissolved');
    expect(change.previous).not.toBeNull();
    expect(field(change.previous, 'value')).toBe('active');
  });

  it('identifies officers by name+role, not by the registry row key', () => {
    const renumbered: Item = {
      key: 'registry:officer:row-9', type: 'officer',
      name: 'Jane Doe', role: 'CFO', appointed_on: '2022-04-01',
    };
    const baseline = load('registry.baseline');
    const next: Snapshot = {
      ...baseline,
      snapshot_id: 'snap-nordvale-registry-renumbered',
      items: baseline.items.map((item) =>
        field(item, 'name') === 'Jane Doe' ? renumbered : item),
    };
    // Same person under a new row key is not a departure and not an arrival.
    expect(diffSnapshot(next, baseline, OPTS).changes).toEqual([]);
  });
});

describe('court', () => {
  it('a new docket number is one `added`', () => {
    const result = diff('court.new-docket', 'court.baseline');
    const change = only(result.changes);
    expect(change.kind).toBe('added');
    expect(field(change.item, 'docket_number')).toBe('26CV1180');
    expect(change.previous).toBeNull();
  });
});

describe('news', () => {
  it('collapses one story under three outlet URLs into ONE item', () => {
    const result = diff('news.syndicated', 'news.baseline');
    const change = only(result.changes);
    expect(change.kind).toBe('added');
    expect(field(change.item, 'headline_norm'))
      .toBe('nordvale cfo jane doe steps down after four years');
    // The outlets we folded away are kept on the item, not discarded.
    expect(field(change.item, 'also_seen_at')).toEqual([
      'https://citybusiness.example/2026/10/nordvale-cfo-exit',
      'https://regionaldesk.example/business/nordvale-cfo',
    ]);
  });

  it('stores the story once in the baseline, so run three stays quiet too', () => {
    const syndicated = load('news.syndicated');
    const first = diffSnapshot(syndicated, null, OPTS);
    expect(first.baselineItems).toHaveLength(2); // the depot story + one CFO story
    const third = diffSnapshot(refetch(syndicated), syndicated, OPTS);
    expect(third.changes).toEqual([]);
  });

  it('normalises case, punctuation and whitespace to one key', () => {
    const expected = 'nordvale cfo jane doe steps down after four years';
    expect(normaliseHeadline('Nordvale CFO Jane Doe steps down after four years')).toBe(expected);
    expect(normaliseHeadline('Nordvale CFO Jane Doe Steps Down After Four Years')).toBe(expected);
    expect(normaliseHeadline('Nordvale  CFO Jane Doe steps down — after four years.'))
      .toBe(expected);
  });
});

describe('jobs', () => {
  it('a count going 28 -> 12 is one `altered` whose `previous` holds 28', () => {
    const result = diff('jobs.count-dropped', 'jobs.baseline');
    const change = only(result.changes);
    expect(change.kind).toBe('altered');
    expect(change.item.key).toBe('jobs:count');
    expect(field(change.item, 'open_roles')).toBe(12);
    expect(field(change.previous, 'open_roles')).toBe(28);
  });

  it('treats titles as a set: one removed, one added', () => {
    const result = diff('jobs.titles-changed', 'jobs.baseline');
    expect(result.changes).toHaveLength(2);
    const removed = only(result.changes.filter((c) => c.kind === 'removed'));
    const added = only(result.changes.filter((c) => c.kind === 'added'));
    expect(field(removed.item, 'title')).toBe('Accounts Payable Clerk');
    expect(field(added.item, 'title')).toBe('Restructuring Analyst');
  });
});

describe('domain', () => {
  it('a homepage content-hash change is `altered` and keeps the title diff', () => {
    const result = diff('domain.homepage-changed', 'domain.baseline');
    const change = only(result.changes);
    expect(change.kind).toBe('altered');
    expect(change.item.type).toBe('homepage');
    expect(field(change.item, 'content_hash')).toBe('sha256:b7d914');
    expect(field(change.previous, 'content_hash')).toBe('sha256:a1f0c3');
    // The point of Rule 2's "keep the title diff": both titles survive on the
    // Change, so a briefing can say what the page now says instead of only
    // that some bytes moved.
    expect(field(change.previous, 'title')).toBe('Nordvale Freight Systems | Contract Logistics');
    expect(field(change.item, 'title')).toBe('Nordvale Freight Systems | Service notice');
  });

  it('diffs WHOIS field by field', () => {
    const result = diff('domain.whois-changed', 'domain.baseline');
    const change = only(result.changes);
    expect(change.kind).toBe('altered');
    expect(field(change.item, 'field')).toBe('registrar');
    expect(field(change.previous, 'value')).toBe('MarkMonitor Inc.');
    expect(field(change.item, 'value')).toBe('Tucows Domains Inc.');
  });

  it('a retitled homepage under an unchanged hash is not a change', () => {
    const baseline = load('domain.baseline');
    const next: Snapshot = {
      ...baseline,
      snapshot_id: 'snap-nordvale-domain-retitled',
      items: baseline.items.map((item) =>
        item.type === 'homepage' ? { ...item, title: 'Nordvale' } : item),
    };
    expect(diffSnapshot(next, baseline, OPTS).changes).toEqual([]);
  });
});

describe('executives, regulator and layoffs', () => {
  it('a new executive move is `added`, keyed on person+role+date', () => {
    const change = only(diff('executives.new-move', 'executives.baseline').changes);
    expect(change.kind).toBe('added');
    expect(field(change.item, 'date')).toBe('2026-10-08');
  });

  it('a licence status change under the same id is `altered`, not a new licence', () => {
    const change = only(diff('regulator.licence-revoked', 'regulator.baseline').changes);
    expect(change.kind).toBe('altered');
    expect(field(change.previous, 'status')).toBe('active');
    expect(field(change.item, 'status')).toBe('revoked');
  });

  it('a new layoff notice is `added`', () => {
    const change = only(diff('layoffs.new-notice', 'layoffs.baseline').changes);
    expect(change.kind).toBe('added');
    expect(field(change.item, 'id')).toBe('WARN-OH-2026-0503');
  });
});

describe('the rule table is data, not control flow', () => {
  it('covers every source in the contract', () => {
    for (const source of Object.keys(SOURCE_RULES)) {
      expect(SOURCE_RULES[source as keyof typeof SOURCE_RULES].default).toBeDefined();
    }
    // Adding a source must be a row here, so the count tracks the enum.
    expect(Object.keys(SOURCE_RULES)).toHaveLength(8);
  });

  it('namespaces identity by type, so ids never collide across record kinds', () => {
    const officer: Item = { key: 'k', type: 'officer', name: 'A', role: 'CFO' };
    const filing: Item = { key: 'k', type: 'filing', filing_id: 'A' };
    expect(identityOf('registry', officer)).not.toBe(identityOf('registry', filing));
  });
});

// ---------------------------------------------------------------------------
// Rule 3. Advancing the baseline -- values only, no store.
// ---------------------------------------------------------------------------
describe('Rule 3: reporting the new baseline', () => {
  const snapshots = [
    load('registry.baseline'), load('registry.officer-removed'),
    load('court.baseline'), load('court.new-docket'),
  ];

  it('picks the newest ok snapshot per company+source', () => {
    const pointers = advanceBaselines(snapshots);
    expect(pointers).toEqual([
      {
        company_id: 'nordvale', source: 'court',
        snapshot_id: 'snap-nordvale-court', fetched_at: '2026-10-10T06:00:00Z',
      },
      {
        company_id: 'nordvale', source: 'registry',
        snapshot_id: 'snap-nordvale-registry', fetched_at: '2026-10-10T06:00:00Z',
      },
    ]);
  });

  it('compares instants as moments, not as text', () => {
    const [older, newer] = [load('registry.baseline'), load('registry.officer-removed')];
    // '...:00.000Z' sorts BEFORE '...:00Z' as a string, so a text compare here
    // would hand back the week-old snapshot and re-report an old change as new.
    const fractional: Snapshot = { ...newer, fetched_at: '2026-10-10T06:00:00.000Z' };
    expect(latestOkSnapshot([older!, fractional], 'nordvale', 'registry')?.snapshot_id)
      .toBe(fractional.snapshot_id);
  });

  it('returns null when a company+source has nothing, which is Rule 1 input', () => {
    expect(latestOkSnapshot(snapshots, 'nordvale', 'news')).toBeNull();
    expect(latestOkSnapshot(snapshots, 'unknown-co', 'registry')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The output contract.
// ---------------------------------------------------------------------------
describe('every emitted Change is a valid Change', () => {
  it('produced changes in the tests above', () => {
    expect(allEmitted.length).toBeGreaterThan(0);
  });

  it('validates against changeSchema', () => {
    for (const change of allEmitted) {
      const result = changeSchema.safeParse(change);
      if (!result.success) {
        throw new Error(
          `${change.source}/${change.kind} failed:\n` +
            result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
        );
      }
    }
  });

  it('carries book_id on every change', () => {
    for (const change of allEmitted) expect(change.book_id).toBe('book-demo');
  });

  it('carries the snapshot pair it compared, so a claim can be re-checked', () => {
    for (const change of allEmitted) {
      expect(change.snapshot_id.length).toBeGreaterThan(0);
      expect(change.baseline_id.length).toBeGreaterThan(0);
      expect(change.baseline_id).not.toBe(change.snapshot_id);
      expect(change.detected_at).toBe(OPTS.detectedAt);
    }
  });

  it('gives `previous` the uniform meaning "state in the baseline, or null"', () => {
    for (const change of allEmitted) {
      if (change.kind === 'added') expect(change.previous).toBeNull();
      else expect(change.previous).not.toBeNull();
    }
  });
});

describe('preconditions', () => {
  it('refuses to diff across companies or sources', () => {
    const registry = load('registry.baseline');
    const court = load('court.baseline');
    expect(() => diffSnapshot(registry, court, OPTS)).toThrow(/does not match/);
    expect(() => diffSnapshot(registry, { ...registry, company_id: 'halcyon' }, OPTS))
      .toThrow(/does not match/);
  });

  it('is pure: the same inputs twice give the same output', () => {
    const [next, baseline] = [load('jobs.count-dropped'), load('jobs.baseline')];
    expect(diffSnapshot(next, baseline, OPTS)).toEqual(diffSnapshot(next, baseline, OPTS));
    expect(next.items).toEqual(load('jobs.count-dropped').items);
  });
});
