/**
 * lookup -- a counterparty profile BEFORE the signature.
 *
 *   npx vite-node scripts/lookup.ts --name "Acme Corp" --country US          # REPLAY (default): 0 credits
 *   npx vite-node scripts/lookup.ts --name "Acme Corp" --country US --live   # spends credits, writes the book
 *   npx vite-node scripts/lookup.ts --name "Acme Corp" --watch-until 2026-11-30
 *
 * Calls runLookup directly -- the same entry point the orchestrator loop uses
 * for a lookup intent the surface wrote. Resolution, one batch over all eight
 * sources, the first-run profile. ONE SHOT: no schedules unless --watch-until,
 * and the last line printed says whether any were written.
 *
 * REPLAY IS THE DEFAULT and touches nothing: an in-memory store, the
 * collectors repo's saved fixtures, the narrator's code fallback, and a
 * replay resolver that matches against ohio-companies.json -- or, for a name
 * outside that universe, accepts the name as typed and SAYS SO. Replay never
 * searches a registry, so it cannot show a real resolution decision.
 *
 * --live requires DONNA_LOOKUP_CREDIT_CEILING (separate from
 * DONNA_CREDIT_CEILING, which also applies), plus BRIGHTDATA_API_KEY and the
 * Mongo + book env: a live lookup is a real prospect in the real book.
 */
import { SOURCES, type Source } from '@donna/contracts';
import { DonnaStore } from '@donna/store';
import { BrightDataFetcher, readCreditCeiling } from '@donna/fetch';
import {
  runLookup, openCorporatesCandidates, makeJudge, clientFromEnv,
  type CandidateSource, type Judge, type LookupDeps, type LookupStore,
} from '@donna/orchestrator';
import type { CanonicalCompany, Fetcher } from '../../donna-collectors/src/contract.js';
import { UsageError, flagValue, loadEnv, requireEnv } from './lib/env.js';
import { InMemoryLookupStore } from './lib/memstore.js';
import { MeteredFetcher } from './lib/metered.js';
import { loadOhioCompanies, findCompany } from './lib/ohio.js';
import { pipeline } from './lib/pipeline.js';
import { replayFetcher } from './lib/replay.js';

const usage = (): never => {
  console.error(
    'usage: npx vite-node scripts/lookup.ts --name <company> [--country US] [--watch-until YYYY-MM-DD]\n' +
      '                                   [--requested-by <who>] [--live] [--env <path>]\n' +
      '  default is REPLAY: in memory, saved fixtures, zero credits, zero writes.\n' +
      '  --live fetches through Bright Data and writes the book; needs DONNA_LOOKUP_CREDIT_CEILING.',
  );
  process.exit(2);
};

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) usage();
const live = argv.includes('--live');
loadEnv(flagValue(argv, '--env'));

const name: string = flagValue(argv, '--name')?.trim() || usage();
const country = (flagValue(argv, '--country') ?? 'US').trim().toUpperCase();
const watchUntil = flagValue(argv, '--watch-until')?.trim() ?? null;
const requestedBy = flagValue(argv, '--requested-by')?.trim() || 'cli';

const positiveInt = (raw: string, name: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
};

let store: LookupStore;
let schedulesFor: (companyId: string) => Promise<Array<{ expires_at?: string | null }>>;
let candidates: CandidateSource;
let judge: Judge;
let fetcherFor: (company: CanonicalCompany, source: Source) => Fetcher;
let lookupCeiling: number;
let liveMetered: MeteredFetcher | null = null;
let closeStore: () => Promise<void> = async () => {};
let bookId: string;

if (live) {
  lookupCeiling = positiveInt(
    requireEnv(process.env, 'DONNA_LOOKUP_CREDIT_CEILING',
      'a live lookup is a full pass; without its own ceiling a few curious clicks spend the event budget'),
    'DONNA_LOOKUP_CREDIT_CEILING',
  );
  requireEnv(process.env, 'BRIGHTDATA_API_KEY', 'a live lookup authenticates to Bright Data with it');
  const uri = requireEnv(process.env, 'MONGODB_URI', 'a live lookup is a prospect in the real book');
  const database = requireEnv(process.env, 'MONGODB_DATABASE', 'a live lookup needs a database name');
  bookId = requireEnv(process.env, 'DONNA_BOOK_ID', 'every document is stamped with it');

  const real = await DonnaStore.connect({ uri, database, bookId });
  store = real as unknown as LookupStore;
  schedulesFor = (id) => real.schedulesForCompany(id);
  closeStore = () => real.close();

  const fetcher = new BrightDataFetcher({ mode: 'live' });
  candidates = openCorporatesCandidates({
    unlocker: async (url) => { const r = await fetcher.unlocker(url); return { body: r.body, url: r.url }; },
    serp: async (q) => { const r = await fetcher.serpResults(q); return { body: r.body, url: r.url }; },
  });
  judge = makeJudge(clientFromEnv());
  liveMetered = new MeteredFetcher(new BrightDataFetcher({ mode: 'live' }));
  fetcherFor = () => liveMetered!;
} else {
  bookId = process.env.DONNA_BOOK_ID || 'replay';
  const mem = new InMemoryLookupStore(bookId);
  store = mem as unknown as LookupStore;
  schedulesFor = async (id) => mem.schedulesFor(id);
  const ceiling = process.env.DONNA_LOOKUP_CREDIT_CEILING;
  lookupCeiling = ceiling ? positiveInt(ceiling, 'DONNA_LOOKUP_CREDIT_CEILING') : Number.POSITIVE_INFINITY;

  const seed = findCompany(loadOhioCompanies(), name);
  const replayId = seed?.registry_id || `REPLAY-${name.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}`;
  candidates = {
    search: async () => [{
      canonical_name: seed?.canonical_name ?? name, registry_id: replayId, jurisdiction: seed?.jurisdiction ?? country,
    }],
    identify: async () => ({ domains: seed?.domains ?? [], aliases: seed?.aliases ?? [] }),
  };
  judge = {
    resolve: async () => ({
      registry_id: replayId,
      confidence: 1,
      reason: seed
        ? 'Replay: matched by name in the fixed universe (ohio-companies.json); no registry was searched.'
        : 'Replay: accepted the name as typed; no registry was searched.',
    }),
  };
  fetcherFor = (company, source) => replayFetcher(company, source);
}

const { batch, wrap } = pipeline({
  bookId,
  fetcherFor: (c, s) => fetcherFor(c, s),
  narrateOptions: live ? {} : { client: null },
});

const deps: LookupDeps = {
  store: wrap(store),
  candidates,
  judge,
  batch,
  lookupCeiling,
  ...(live && readCreditCeiling() !== undefined ? { creditCeiling: readCreditCeiling()! } : {}),
};

try {
  console.log(
    `${live ? 'LIVE (spending credits, writing the book)' : 'REPLAY (fixtures, zero credits, nothing written)'} ` +
      `| ${name} (${country}) | ${watchUntil ? `watch until ${watchUntil}` : 'one shot'}\n`,
  );
  const out = await runLookup({ name, country, requestedBy, watchUntil }, deps);

  console.log(`status      ${out.status}${out.reason ? ` -- ${out.reason}` : ''}`);
  if (out.resolution) {
    console.log(
      `resolution  ${out.resolution.status} (confidence ${out.resolution.confidence ?? 'n/a'}) ${out.resolution.reason}`,
    );
    if (out.resolution.status === 'needs_review' && out.resolution.candidates_seen.length) {
      for (const c of out.resolution.candidates_seen) console.log(`  candidate ${JSON.stringify(c)}`);
    }
  }
  if (out.company_id) console.log(`company     ${out.company_id}`);

  if (out.runs.length) {
    console.log('\n--- sources -----------------------------------------------------------');
    for (const source of SOURCES) {
      const r = out.runs.find((x) => x.source === source);
      console.log(
        `  ${source.padEnd(11)} ${(r?.status ?? 'not run').padEnd(7)} ${String(r?.credits_spent ?? 0).padStart(3)} cr` +
          `${r?.error ? `  ${r.error}` : ''}`,
      );
    }
  }

  if (out.briefing_id && out.company_id) {
    const profile = await store.latestBriefing(out.company_id, 'profile');
    const sections = (profile?.['sections'] ?? []) as Array<{ title: string; text: string; gap?: boolean }>;
    console.log(`\n--- profile (${String(profile?.['narration_status'] ?? 'unknown')}) -----------------------------------------`);
    for (const s of sections) console.log(`\n## ${s.title}${s.gap ? '  [gap]' : ''}\n${s.text}`);
  }

  if (out.coverage) {
    console.log('\n--- coverage ----------------------------------------------------------');
    console.log(`  checked  ${out.coverage.checked.join(', ') || 'none'}`);
    console.log(`  failed   ${out.coverage.failed.join(', ') || 'none'}`);
  }

  console.log('\n--- summary -----------------------------------------------------------');
  if (liveMetered) {
    const totals = MeteredFetcher.totals(liveMetered.calls);
    console.log(
      `credits     ${out.credits_spent} recorded on runs, ${totals.credits} metered (${totals.fetches} fetches), ` +
        `lookup ceiling ${lookupCeiling}, book ceiling ${readCreditCeiling() ?? 'unset'}`,
    );
  } else {
    console.log(`credits     0 spent (replay; runs record ${out.credits_spent}, the recorded cost of the captures)`);
  }
  if (out.baseline_violations.length) {
    for (const v of out.baseline_violations) console.log(`!!! NOT A BASELINE: ${v}`);
    process.exitCode = 1;
  }
  const schedules = out.company_id ? await schedulesFor(out.company_id) : [];
  console.log(
    schedules.length === 0
      ? 'schedules   NONE written -- one shot; nothing about this company will run again'
      : `schedules   ${schedules.length} written, expiring ${[...new Set(schedules.map((s) => s.expires_at ?? 'never'))].join(', ')}`,
  );
  if (!live) {
    console.log('replay note: fixture items describe the recorded captures (Big Lots / Battelle / BBW), not this company.');
  }
  if (out.status === 'over_ceiling' || out.status === 'needs_review' || out.status === 'could_not_look') {
    process.exitCode = 1;
  }
} finally {
  await closeStore();
}
