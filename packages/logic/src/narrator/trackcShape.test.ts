import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { briefingSchema, clusterSchema, signalSchema, type Signal } from '@donna/contracts';
import { narratorInput } from './types.js';
import { buildFallbackDraft } from './fallback.js';
import { postProcess } from './postprocess.js';

/**
 * Shape compatibility with the briefings Track C actually renders.
 *
 * The fixture briefings predate tenancy, so they carry no book_id and no
 * cluster_id. Everything else must line up key for key, because Track C reads
 * these documents field by field and a renamed or missing field is a blank
 * panel rather than an error.
 */
const fx = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../fixtures/trackc/allContracts.sample.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, Record<string, unknown>[]>;

const BOOK = 'book-trackc';

/** The fixture signals predate `title`/`touches_terms`; fill them in to parse. */
const fixtureSignals = (companyId: string): Signal[] =>
  (fx['signals'] ?? [])
    .filter((s) => s['company_id'] === companyId)
    .map((s) =>
      signalSchema.parse({
        book_id: BOOK,
        title: s['type'],
        touches_terms: [],
        ...s,
      }),
    );

describe('our briefings match the shapes Track C renders', () => {
  for (const mode of ['briefing', 'profile'] as const) {
    it(`${mode} mode, against the real ${mode} fixture`, () => {
      const fixtureBriefing = (fx['briefings'] ?? []).find((b) => b['mode'] === mode);
      expect(fixtureBriefing, `no ${mode} fixture`).toBeDefined();

      const rawCluster = (fx['clusters'] ?? [])[0];
      const cluster = clusterSchema.parse({ ...rawCluster, book_id: BOOK, mode });
      const all = fixtureSignals(cluster.company_id);
      // Profile mode narrates the baseline signal; briefing mode the change.
      const wanted = all.filter((s) =>
        mode === 'profile' ? s.status === 'baseline' : s.status !== 'baseline',
      );
      const withSignals = clusterSchema.parse({
        ...cluster,
        signals: wanted.map((s) => s.signal_id),
        verify_with_counterparty: mode === 'briefing',
      });

      const input = narratorInput(withSignals, wanted, '2026-10-10T19:42:30Z');
      const result = postProcess(buildFallbackDraft(input), input, {
        narration_status: 'fallback',
      });
      expect(result.ok, JSON.stringify(result.report.violations)).toBe(true);
      if (!result.ok) return;

      // Every field Track C reads is present.
      const ours = new Set(Object.keys(result.briefing));
      for (const key of Object.keys(fixtureBriefing!)) {
        expect(ours.has(key), `missing field ${key}`).toBe(true);
      }
      // And the only fields we add are the two the fixtures predate.
      const extra = [...ours].filter(
        (k) => !(k in fixtureBriefing!) && k !== 'citations' && k !== 'narration_status',
      );
      expect(extra.sort()).toEqual(['book_id', 'cluster_id']);

      expect(briefingSchema.safeParse(result.briefing).success).toBe(true);
      expect(JSON.stringify(result.briefing.coverage)).toBe(
        JSON.stringify(withSignals.coverage),
      );
    });
  }
});
