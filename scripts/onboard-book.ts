/**
 * onboard-book -- tonight's baseline.
 *
 *   npx vite-node scripts/onboard-book.ts              # DRY RUN (default): full pipeline, in-memory
 *   npx vite-node scripts/onboard-book.ts --commit     # writes to the live book, spends credits
 *   npx vite-node scripts/onboard-book.ts --commit --sources news,executives
 *
 * Runs a full onboarding pass over every seeded company through the REAL
 * pipeline: runBatch (orchestrator) -> collectors (donna-collectors) -> differ
 * -> validator -> narrator, storing snapshots, runs, signals, the cluster, a
 * profile briefing and the coverage record. The demo then has a stored
 * baseline and the live fetch on stage is one company, not thirty.
 *
 * DRY RUN IS THE DEFAULT and touches nothing: companies come from
 * ohio-companies.json into an in-memory BatchStore, fetches replay the
 * collectors repo's saved fixtures, and narration runs the code fallback (no
 * Anthropic call). It is the real pipeline, not a mock of it.
 *
 * --commit requires DONNA_BOOK_ID + MONGODB_URI + MONGODB_DATABASE +
 * DONNA_CREDIT_CEILING, and DONNA_FETCH_MODE must be `live` or `record`. It
 * REFUSES replay mode on purpose: the replay fixtures are other companies'
 * captured pages, and committing them would store a wrong company's evidence
 * as this company's baseline.
 *
 * THE FIRST RUN IS A BASELINE AND NEVER AN ALERT: the differ emits no changes
 * and the validator produces status 'baseline' signals for the profile. This
 * script asserts it per company and says so LOUDLY if it is not true.
 */
import {
  SOURCES, batchId, utcDay,
  type Cluster, type Company, type Deal, type Signal, type Source,
} from '@donna/contracts';
import { DonnaStore } from '@donna/store';
import { resolveFetchMode, assertLiveEnv, BrightDataFetcher, readCreditCeiling } from '@donna/fetch';
import { narrate, narratorInput, validate } from '@donna/logic';
import {
  runBatch,
  type BatchOutcome, type BatchStore, type CollectorRunner,
} from '../packages/orchestrator/src/run-batch.js';
import { LocalSandboxRunner } from '../packages/orchestrator/src/sandbox-local.js';
import { collectors } from '../../donna-collectors/src/index.js';
import type { CanonicalCompany, Fetcher } from '../../donna-collectors/src/contract.js';
import { UsageError, flagValue, loadEnv, requireEnv } from './lib/env.js';
import { InMemoryBatchStore } from './lib/memstore.js';
import { MeteredFetcher } from './lib/metered.js';
import { findCompany, loadOhioCompanies } from './lib/ohio.js';
import { replayFetcher } from './lib/replay.js';

const usage = (): never => {
  console.error(
    'usage: npx vite-node scripts/onboard-book.ts [--commit] [--company <name|index>] [--sources a,b] [--env <path>]\n' +
      '  default is --dry-run: the real pipeline in memory, replay fetches, zero writes, zero credits.\n' +
      '  --commit writes through DonnaStore and fetches live (needs the Mongo + Bright Data env).',
  );
  process.exit(2);
};

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) usage();
const commit = argv.includes('--commit');
loadEnv(flagValue(argv, '--env'));

const bookId = requireEnv(
  process.env,
  'DONNA_BOOK_ID',
  'every document is stamped with it; a wrong one makes the baseline invisible to the UI',
);

const sourcesArg = flagValue(argv, '--sources');
const sources: Source[] = (sourcesArg ? sourcesArg.split(',') : [...SOURCES]).map((s) => {
  const t = s.trim() as Source;
  if (!SOURCES.includes(t)) {
    throw new UsageError(`unknown source ${JSON.stringify(s)} -- expected one of ${SOURCES.join(', ')}`);
  }
  return t;
});

// The summary needs run rows and signal/briefing lookups beyond the BatchStore
// seam; both concrete stores provide them.
interface SummaryStore extends BatchStore {
  runsForBatch(b: string): Promise<readonly { source: string; status: string }[]>;
  signalsForCompany(c: string): Promise<Signal[]>;
  latestBriefing(c: string, m: 'briefing' | 'profile'): Promise<Record<string, unknown> | null>;
}

interface CompanyEntry {
  company_id: string;
  name: string;
  canonical: CanonicalCompany;
}

let store: SummaryStore;
let companies: CompanyEntry[];
let liveMetered: MeteredFetcher | null = null;
let closeStore: () => Promise<void> = async () => {};

const toEntry = (
  company_id: string,
  canonical_name: string,
  jurisdiction: string,
  registry_id: string,
  aliases: string[],
  domains: string[],
): CompanyEntry => ({
  company_id,
  name: canonical_name,
  canonical: { company_id, canonical_name, jurisdiction, registry_id, aliases, domains },
});

if (commit) {
  const mode = resolveFetchMode();
  if (mode === 'replay') {
    throw new UsageError(
      '--commit with DONNA_FETCH_MODE=replay would store OTHER companies\' captured pages ' +
        'as this company\'s baseline. Set DONNA_FETCH_MODE=live (or record) for a real baseline, ' +
        'or run without --commit for the dry-run pipeline.',
    );
  }
  const uri = requireEnv(process.env, 'MONGODB_URI', 'the committed baseline writes to MongoDB');
  const database = requireEnv(process.env, 'MONGODB_DATABASE', 'the committed baseline needs a database name');
  requireEnv(process.env, 'DONNA_CREDIT_CEILING', 'a live onboarding pass must be capped before it starts');
  // Both zones, before the first company: a missing unlocker zone otherwise
  // surfaces as six failed sources per company, one company at a time.
  assertLiveEnv(process.env, mode);

  const real = await DonnaStore.connect({ uri, database, bookId });
  store = real as unknown as SummaryStore;
  closeStore = () => real.close();

  const stored = await real.listCompanies();
  if (stored.length === 0) {
    throw new UsageError('the book has no companies -- run scripts/seed-book.ts --commit first.');
  }

  // Collect only companies whose schedules are ENABLED.
  //
  // Without this the pass walks every seeded company, and the budget does not
  // survive that: measure-credits put one full pass at 13 credits, so 30
  // companies is ~390 against a 300-credit event budget -- and a BRIEFING needs
  // two passes, because the first run is a baseline by design. The paused
  // companies stay in the book and on the page; they are simply not fetched.
  const enabledIds = new Set(
    (await real.dueSchedules(new Date(Date.now() + 365 * 24 * 3600 * 1000)))
      .filter((s) => s.enabled !== false)
      .map((s) => s.company_id),
  );
  const selectable = stored.filter((c) => enabledIds.has(c.company_id));
  if (selectable.length === 0) {
    throw new UsageError(
      'every schedule in this book is disabled, so there is nothing to collect. ' +
      'Run scripts/pick-universe.mjs --commit to choose which companies to monitor.',
    );
  }
  console.log(
    `collecting ${selectable.length} of ${stored.length} companies ` +
    `(${stored.length - selectable.length} paused), ~${selectable.length * 13} credits for this pass\n`,
  );
  companies = selectable.map((c) =>
    toEntry(c.company_id, c.canonical_name, c.jurisdiction, c.registry_id, c.aliases ?? [], c.domains ?? []),
  );
  liveMetered = new MeteredFetcher(new BrightDataFetcher());
} else {
  const mem = new InMemoryBatchStore(bookId);
  const seeds = loadOhioCompanies();
  companies = seeds.map((seed) => {
    const slug = seed.canonical_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const companyId = `oh-${slug}`;
    mem.seedCompany({
      company_id: companyId,
      canonical_name: seed.canonical_name,
      jurisdiction: seed.jurisdiction,
      registry_id: seed.registry_id,
      registry_key: seed.registry_id ? seed.registry_id.toUpperCase() : `MANUAL:${companyId}`,
      aliases: seed.aliases,
      domains: seed.domains,
      officers: [],
      related_entities: [],
      resolution: { confidence: null, reason: 'dry-run seed', resolved_by: 'onboard-book' },
    });
    return toEntry(companyId, seed.canonical_name, seed.jurisdiction, seed.registry_id, seed.aliases, seed.domains);
  });
  store = mem as unknown as SummaryStore;
}

// --company narrows the pass. On a commit run that is how "one company on
// stage" is expressed; on a dry run it picks a seed by name or index.
const pick = flagValue(argv, '--company');
if (pick) {
  const needle = pick.trim().toLowerCase();
  if (commit) {
    companies = companies.filter(
      (c) =>
        c.name.toLowerCase() === needle
        || c.canonical.aliases.some((a) => a.toLowerCase() === needle),
    );
  } else {
    const seeds = loadOhioCompanies();
    const seed = findCompany(seeds, pick);
    companies = seed
      ? companies.filter((c) => c.name === seed.canonical_name)
      : [];
  }
  if (companies.length === 0) {
    throw new UsageError(`no company matches ${JSON.stringify(pick)}.`);
  }
}

// --- the real pieces ---------------------------------------------------------

const fetcherFor = (company: CanonicalCompany, source: Source): Fetcher =>
  liveMetered ?? replayFetcher(company, source);

/** Collectors in-process. The run record's sandbox_id says so honestly. */
const directRunner: CollectorRunner = {
  async collect({ company, source, runId }) {
    const canonical = toEntry(
      company.company_id, company.canonical_name, company.jurisdiction,
      company.registry_id, company.aliases, company.domains,
    ).canonical;
    const envelope = await collectors[source](canonical, {
      fetcher: fetcherFor(canonical, source),
      now: () => new Date().toISOString(),
      runId,
    });
    return { envelope, sandbox_id: 'in-process' };
  },
};

// runBatch calls setCoverage immediately before validate, so wrapping it here
// hands the validator the coverage the batch actually produced -- the cluster
// and briefing then carry real checked/failed lists rather than the empty set.
// (A Proxy because BatchStore methods live on the prototype: a spread loses them.)
let lastCoverage: Parameters<BatchStore['setCoverage']>[1] | undefined;
const coverageCapturingStore = new Proxy(store, {
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

const depsFor = (): Parameters<typeof runBatch>[3] => ({
  store: coverageCapturingStore,
  collectors: directRunner,
  sandboxes: new LocalSandboxRunner(), // required by the seam; unused by runBatch
  bookId,
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
      // Dry run never calls Anthropic: the code fallback is the same briefing
      // the pipeline produces when the model is unavailable.
      commit ? {} : { client: null },
    );
    return { briefing: result.briefing };
  },
});

try {
  let processed = 0;
  let alerted = 0;

  for (const entry of companies) {
    const batch = batchId(entry.company_id, utcDay());
    const priorSignals = await store.signalsForCompany(entry.company_id);
    const rerun = priorSignals.length > 0;

    let outcome: BatchOutcome;
    try {
      outcome = await runBatch(entry.company_id, sources, batch, depsFor());
    } catch (err) {
      console.log(`${entry.name}: BATCH FAILED -- ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const runs = await store.runsForBatch(batch);
    const signals = await store.signalsForCompany(entry.company_id);
    const profile = await store.latestBriefing(entry.company_id, 'profile');
    const nonBaseline = signals.filter((s) => s.status !== 'baseline');

    // A first run is a baseline and never an alert. If the validator produced
    // change-alerts here, something upstream is wrong and it must be loud.
    const firstRunAlert = !rerun && (outcome.changes > 0 || nonBaseline.length > 0);
    if (firstRunAlert) alerted += 1;

    const byStatus = (s: string): number => runs.filter((r) => r.status === s).length;
    const failedNames = runs.filter((r) => r.status === 'failed').map((r) => r.source);
    processed += 1;

    console.log(
      `${entry.name}\n` +
        `  sources   ok=${byStatus('ok')} empty=${byStatus('empty')} failed=${byStatus('failed')}` +
        `${failedNames.length ? ` (${failedNames.join(', ')})` : ''}\n` +
        `  snapshots ${outcome.ok}  changes=${outcome.changes}  signals=${signals.length}` +
        `  profile=${profile ? `yes (${String(profile['narration_status'] ?? 'unknown')})` : 'NO'}\n` +
        `  coverage  checked=${outcome.coverage.checked.length} failed=[${outcome.coverage.failed.join(',')}]` +
        `${rerun ? '  [re-run: prior signals exist]' : ''}`,
    );
    if (firstRunAlert) {
      console.log(
        `  !!! FIRST RUN PRODUCED ALERTS: changes=${outcome.changes} ` +
          `non-baseline signals=${nonBaseline.map((s) => `${s.type}:t${s.tier}`).join(',') || 'none'} -- ` +
          'a baseline run must not alert; something upstream is wrong.',
      );
    }
  }

  console.log('\n--- summary ---------------------------------------------------------');
  console.log(`${processed}/${companies.length} companies processed (${commit ? 'COMMITTED' : 'dry run, nothing written'})`);
  if (alerted > 0) {
    console.log(`!!! ${alerted} compan${alerted === 1 ? 'y' : 'ies'} produced alerts on a first run -- see above.`);
    process.exitCode = 1;
  }
  if (liveMetered) {
    const totals = MeteredFetcher.totals(liveMetered.calls);
    console.log(
      `credits spent: ${liveMetered.creditsSpent() ?? totals.credits} ` +
        `(${totals.fetches} fetches, ceiling ${readCreditCeiling() ?? 'unset'})`,
    );
  } else {
    console.log(
      'replay note: fixture items describe the recorded captures (Big Lots / Battelle / BBW), not each company.',
    );
  }
} finally {
  await closeStore();
}
