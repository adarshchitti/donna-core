import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  companySchema, dealSchema, collectorEnvelopeSchema, collectorRunSchema,
  snapshotSchema, changeSchema, signalSchema, clusterSchema, briefingSchema,
  coverageSchema, SOURCES, SOURCE_LABELS, NOT_COVERED_CATEGORIES,
  sourceIdFromLabel, SOURCE_TRUST, runId, snapshotId, batchId,
  latestSnapshotAlias, parseLatestSnapshotAlias,
} from './index.js';

const fixturePath = fileURLToPath(
  new URL('../../../fixtures/trackc/allContracts.sample.json', import.meta.url),
);
const fx = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, any[]>;

/**
 * Track C's fixtures predate tenancy, so they carry no book_id, and its profile
 * fixture omits citations/narration_status. We validate the fixture against a
 * relaxed variant, and separately assert our strict schema is a superset.
 */
const asTrackC = {
  companies: companySchema.omit({ book_id: true, registry_key: true }),
  deals: dealSchema,
  collector_envelopes: collectorEnvelopeSchema,
  collector_runs: collectorRunSchema.omit({ book_id: true }).extend({
    demo: z.boolean().optional(),
  }),
  snapshots: snapshotSchema.omit({ book_id: true }),
  changes: changeSchema.omit({ book_id: true }),
  signals: signalSchema.omit({ book_id: true, title: true }),
  clusters: clusterSchema.omit({ book_id: true }),
} as const;

describe('Track C fixtures validate against our contracts', () => {
  for (const [collection, schema] of Object.entries(asTrackC)) {
    it(`${collection}`, () => {
      const docs = fx[collection];
      expect(docs?.length, `${collection} missing from fixture`).toBeGreaterThan(0);
      for (const doc of docs!) {
        const result = schema.safeParse(doc);
        if (!result.success) {
          throw new Error(
            `${collection} doc failed:\n` +
              result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
          );
        }
      }
    });
  }

  it('briefings (citations + narration_status optional only in the fixture)', () => {
    const relaxed = briefingSchema
      .innerType()
      .omit({ book_id: true, citations: true, narration_status: true });
    for (const doc of fx.briefings!) expect(relaxed.safeParse(doc).success).toBe(true);
  });
});

describe('source identity matches Track C exactly', () => {
  it('uses `executives`, not the PDF\'s `exec_moves`', () => {
    expect(SOURCES).toContain('executives');
    expect(SOURCES).not.toContain('exec_moves');
  });

  it('labels round-trip through sourceId/sourceLabel', () => {
    for (const s of SOURCES) expect(sourceIdFromLabel(SOURCE_LABELS[s])).toBe(s);
  });

  it('keeps the ampersand labels Coverage.jsx depends on', () => {
    expect(SOURCE_LABELS.news).toBe('News & press');
    expect(SOURCE_LABELS.domain).toBe('Domain & site');
  });

  it('every source in the fixture is a known source', () => {
    for (const snap of fx.snapshots!) expect(SOURCES).toContain(snap.source);
    for (const run of fx.collector_runs!) expect(SOURCES).toContain(run.source);
  });

  it('assigns the trust levels the fixture asserts', () => {
    for (const sig of fx.signals!) {
      for (const ev of sig.evidence) expect(SOURCE_TRUST[ev.source as never]).toBe(ev.trust);
    }
  });
});

describe('type discipline that fails silently in the UI', () => {
  it('tier is an integer, never a string', () => {
    for (const sig of fx.signals!) expect(Number.isInteger(sig.tier)).toBe(true);
    for (const cl of fx.clusters!) expect(Number.isInteger(cl.top_tier)).toBe(true);
  });

  it('signal confidence is a word, not a number', () => {
    for (const sig of fx.signals!) expect(['high', 'medium', 'low']).toContain(sig.confidence);
  });

  it('company resolution confidence IS a number -- the other `confidence`', () => {
    for (const c of fx.companies!) expect(typeof c.resolution.confidence).toBe('number');
  });

  it('first_seen is date-only; generated_at is a full instant', () => {
    for (const sig of fx.signals!) expect(sig.first_seen).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const b of fx.briefings!) expect(b.generated_at).toMatch(/T/);
  });
});

describe('coverage semantics', () => {
  it('checked/failed are source ids; not_covered are labels', () => {
    for (const cl of fx.clusters!) {
      const cov = coverageSchema.parse(cl.coverage);
      for (const id of [...cov.checked, ...cov.failed]) expect(SOURCES).toContain(id);
      for (const label of cov.not_covered) expect(SOURCES).not.toContain(label as never);
    }
  });

  it('carries the four non-source categories this system never observes', () => {
    const cov = fx.clusters![0]!.coverage;
    for (const cat of NOT_COVERED_CATEGORIES) expect(cov.not_covered).toContain(cat);
  });

  it('a failed source is listed as failed, never silently dropped', () => {
    const cov = fx.clusters![0]!.coverage;
    const failedRun = fx.collector_runs!.find((r) => r.status === 'failed')!;
    expect(cov.failed).toContain(failedRun.source);
    expect(cov.checked).not.toContain(failedRun.source);
  });
});

describe('id conventions Track C mints client-side', () => {
  it('reproduces run/snapshot/batch ids byte-for-byte', () => {
    const run = fx.collector_runs!.find((r) => r.run_id === 'run-northstar-registry')!;
    expect(runId('northstar', 'registry')).toBe(run.run_id);
    expect(batchId('northstar', '2026-10-10')).toBe(run.batch_id);
  });

  it('matches the snapshot ALIAS, not a real snapshot id', () => {
    // Track C links to `snap-<company>-<source>` meaning "the latest one".
    // Real snapshot ids must be unique per fetch, so getEvidence resolves the
    // alias to the newest ok snapshot rather than finding a doc with that id.
    expect(latestSnapshotAlias('northstar', 'registry')).toBe(fx.snapshots![0]!.snapshot_id);
    expect(parseLatestSnapshotAlias('snap-northstar-registry')).toEqual({
      companyId: 'northstar', source: 'registry',
    });
  });

  it('mints a distinct snapshot id per fetch, so evidence stays addressable', () => {
    const a = snapshotId('northstar', 'registry', '2026-10-10T19:42:00Z');
    const b = snapshotId('northstar', 'registry', '2026-10-11T19:42:00Z');
    expect(a).not.toBe(b);
    // A change cites two DIFFERENT snapshots, or no one can check the claim.
    expect(a).not.toBe(latestSnapshotAlias('northstar', 'registry'));
  });
});

describe('the citation gate that produces blank panels', () => {
  it('every what_changed signal_id resolves and is in its cluster', () => {
    for (const b of fx.briefings!) {
      if (b.mode !== 'briefing') continue;
      const cluster = fx.clusters!.find((c) => c.company_id === b.company_id)!;
      for (const line of b.what_changed) {
        expect(cluster.signals, 'signal_id absent from cluster -> line silently dropped')
          .toContain(line.signal_id);
        const sig = fx.signals!.find((s) => s.signal_id === line.signal_id);
        expect(sig, `dangling signal_id ${line.signal_id}`).toBeDefined();
        expect(sig!.company_id).toBe(b.company_id);
      }
    }
  });

  it('what_changed is never empty -- RecentBriefings dereferences [0]', () => {
    for (const b of fx.briefings!) expect(b.what_changed.length).toBeGreaterThan(0);
  });

  it('a profile briefing always carries sections', () => {
    for (const b of fx.briefings!) {
      if (b.mode === 'profile') expect(b.sections?.length).toBeGreaterThan(0);
    }
  });
});
