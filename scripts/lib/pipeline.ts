/**
 * The real batch pipeline as runBatch's deps, minus the store: collectors in
 * process, the validator, and the narrator. Shared by scripts/lookup.ts and the
 * orchestrator's lookup poll so both run exactly what onboard-book runs.
 */
import type { Cluster, Company, Deal, Source } from '@donna/contracts';
import { narrate, narratorInput, validate, type NarrateOptions } from '@donna/logic';
import type { BatchStore, CollectorRunner, RunBatchDeps } from '../../packages/orchestrator/src/run-batch.js';
import { LocalSandboxRunner } from '../../packages/orchestrator/src/sandbox-local.js';
import { collectors } from '../../../donna-collectors/src/index.js';
import type { CanonicalCompany, Fetcher } from '../../../donna-collectors/src/contract.js';

export interface PipelineOptions {
  bookId: string;
  fetcherFor(company: CanonicalCompany, source: Source): Fetcher;
  /** `{ client: null }` for the code fallback; `{}` to use ANTHROPIC_API_KEY. */
  narrateOptions: NarrateOptions;
  log?: RunBatchDeps['log'];
}

export const pipeline = (opts: PipelineOptions): {
  batch: Omit<RunBatchDeps, 'store'>;
  /** Wraps a store so the validator sees the coverage the batch produced. */
  wrap<S extends BatchStore>(store: S): S;
} => {
  const runner: CollectorRunner = {
    async collect({ company, source, runId }) {
      const canonical: CanonicalCompany = {
        company_id: company.company_id, canonical_name: company.canonical_name,
        jurisdiction: company.jurisdiction, registry_id: company.registry_id,
        aliases: company.aliases, domains: company.domains,
      };
      const envelope = await collectors[source](canonical, {
        fetcher: opts.fetcherFor(canonical, source),
        now: () => new Date().toISOString(),
        runId,
      });
      return { envelope, sandbox_id: 'in-process' };
    },
  };

  // runBatch calls setCoverage immediately before validate (see onboard-book).
  // A Proxy because store methods live on the prototype: a spread loses them.
  let lastCoverage: Parameters<BatchStore['setCoverage']>[1] | undefined;
  const wrap = <S extends BatchStore>(store: S): S => new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'setCoverage') {
        return async (companyId: string, coverage: NonNullable<typeof lastCoverage>) => {
          lastCoverage = coverage;
          return target.setCoverage(companyId, coverage);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  return {
    wrap,
    batch: {
      collectors: runner,
      sandboxes: new LocalSandboxRunner(), // required by the seam; unused by runBatch
      bookId: opts.bookId,
      ...(opts.log ? { log: opts.log } : {}),
      validate: (input) => {
        const r = validate({
          book_id: input.book_id,
          company: input.company as unknown as Company,
          deals: input.deals as unknown as Deal[],
          changes: input.changes,
          existing_signals: input.existing_signals,
          baseline_snapshots: input.baseline_snapshots,
          coverage: lastCoverage,
        });
        return { signals: r.signals, cluster: r.cluster as Record<string, unknown> | null, mode: r.mode };
      },
      narrate: async (input) => {
        const result = await narrate(
          narratorInput(input.cluster as unknown as Cluster, input.signals),
          opts.narrateOptions,
        );
        return { briefing: result.briefing };
      },
    },
  };
};
