/**
 * measure-credits -- the number the cadence decision waits on.
 *
 *   npx vite-node scripts/measure-credits.ts                     # REPLAY (default): zero credits
 *   npx vite-node scripts/measure-credits.ts --company 2         # pick another seed
 *   npx vite-node scripts/measure-credits.ts --company "Big Lots" --live
 *
 * Runs ONE full onboarding pass on ONE company across all eight sources and
 * reports, per source: credits, wall time, ok/empty/failed and bytes. Then it
 * prints what the total implies for 30 companies at the configured cadence, so
 * the cadence decision is arithmetic rather than a guess.
 *
 * REPLAY IS THE DEFAULT and touches nothing: it replays the collectors repo's
 * saved fixtures, so per-source fetch counts and code paths are real while
 * bytes/items reflect the recorded captures, not this company. `--live` is the
 * explicit opt-in that spends Bright Data credits, and it refuses to run
 * without DONNA_CREDIT_CEILING -- a live pass with no ceiling is exactly how a
 * 300-credit budget dies before lunch.
 *
 * Live runs use DONNA_FETCH_MODE=record semantics through BrightDataFetcher:
 * real fetches, written to fixtures/cassettes so today's spend is tomorrow's
 * replay. Expect several sources to FAIL live and that is the report, not a
 * bug: Bright Data refuses government domains by policy (OFAC, Ohio WARN,
 * Ohio eLicense -- HTTP 200, empty body, x-brd-error header). The fetch layer
 * throws POLICY_REFUSED and it is surfaced here as a refusal, never as an
 * empty result.
 */
import { SOURCES, SOURCE_TRUST } from '@donna/contracts';
import { BrightDataFetcher, assertLiveEnv, readCreditCeiling } from '@donna/fetch';
import { CADENCE } from '../packages/orchestrator/src/loop.js';
import { collectors } from '../../donna-collectors/src/index.js';
import type { CanonicalCompany } from '../../donna-collectors/src/contract.js';
import { UsageError, flagValue, loadEnv, requireEnv } from './lib/env.js';
import { MeteredFetcher } from './lib/metered.js';
import { findCompany, loadOhioCompanies, toCanonical } from './lib/ohio.js';
import { replayFetcher } from './lib/replay.js';

const usage = (): never => {
  console.error(
    'usage: npx vite-node scripts/measure-credits.ts [--company <name|index>] [--live] [--env <path>]\n' +
      '  default is replay over saved fixtures -- zero credits, zero network.\n' +
      '  --live spends Bright Data credits and requires DONNA_CREDIT_CEILING + BRIGHTDATA_API_KEY.',
  );
  process.exit(2);
};

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) usage();
const live = argv.includes('--live');
loadEnv(flagValue(argv, '--env'));

const seeds = loadOhioCompanies();
const seed = findCompany(seeds, flagValue(argv, '--company') ?? '0');
if (!seed) throw new UsageError(`no company matches ${JSON.stringify(flagValue(argv, '--company'))} in ohio-companies.json`);
const company: CanonicalCompany = toCanonical(seed, `measure-${seed.canonical_name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);

if (live) {
  requireEnv(process.env, 'DONNA_CREDIT_CEILING', 'a live pass with no ceiling is how a 300-credit budget dies');
  requireEnv(process.env, 'BRIGHTDATA_API_KEY', 'a live pass authenticates to Bright Data with it');
  // The zones too -- a pass that starts without BRIGHTDATA_UNLOCKER_ZONE
  // reports six of eight sources as failures and reads like an outage.
  assertLiveEnv(process.env, 'record');
}

// One shared fetcher in live mode: the ceiling and the cumulative spend are
// only meaningful across the whole pass. Replay builds a per-source fetcher
// because the fixture map differs per source.
const shared = live ? new MeteredFetcher(new BrightDataFetcher({ mode: 'record' })) : null;

interface SourceReport {
  source: string;
  trust: string;
  status: 'ok' | 'empty' | 'failed';
  refused: boolean;
  fetches: number;
  credits: number;
  bytes: number;
  ms: number;
  items: number;
  note: string;
}

const reports: SourceReport[] = [];

console.log(
  `${live ? 'LIVE (spending credits, recording cassettes)' : 'REPLAY (fixtures, zero credits)'} ` +
    `-- ${company.canonical_name} -- one onboarding pass, ${SOURCES.length} sources`,
);

for (const source of SOURCES) {
  const fetcher = shared ?? new MeteredFetcher(replayFetcher(company, source));
  const mark = fetcher.mark();
  const started = Date.now();

  const envelope = await collectors[source](company, {
    fetcher,
    now: () => new Date().toISOString(),
    runId: `measure-${company.company_id}-${source}`,
  });

  const ms = Date.now() - started;
  const calls = fetcher.since(mark);
  const totals = MeteredFetcher.totals(calls);
  const refused =
    calls.some((c) => c.code === 'POLICY_REFUSED')
    || (envelope.error ?? '').includes('blocks government domains');
  const status: SourceReport['status'] = !envelope.ok
    ? 'failed'
    : envelope.items.length === 0
      ? 'empty'
      : 'ok';
  const note = envelope.ok
    ? `${envelope.items.length} item(s), ${totals.fetches} fetch(es)`
    : (envelope.error ?? 'failed').slice(0, 110);

  reports.push({
    source, trust: SOURCE_TRUST[source], status, refused,
    fetches: totals.fetches, credits: envelope.credits_spent, bytes: totals.bytes,
    ms, items: envelope.items.length, note,
  });

  console.log(
    `  ${source.padEnd(10)} ${status.padEnd(7)} ${String(envelope.credits_spent).padStart(2)} cr ` +
      `${String(totals.bytes).padStart(8)} B ${(ms / 1000).toFixed(1)}s  ${note}`,
  );
}

const creditsTotal = shared?.creditsSpent() ?? reports.reduce((n, r) => n + r.credits, 0);

// --- the arithmetic the cadence decision needs -------------------------------

const daily = reports.filter((r) => CADENCE[r.source as keyof typeof CADENCE] === 'daily');
const weekly = reports.filter((r) => CADENCE[r.source as keyof typeof CADENCE] === 'weekly');
const dailyCredits = daily.reduce((n, r) => n + r.credits, 0);
const weeklyCredits = weekly.reduce((n, r) => n + r.credits, 0);
const passCredits = dailyCredits + weeklyCredits;

const N = seeds.length;
console.log('\n--- report ----------------------------------------------------------');
for (const r of reports) {
  const flag = r.refused ? '  <-- REFUSED BY POLICY (not an empty result)' : '';
  console.log(
    `${r.source.padEnd(10)} ${r.trust.padEnd(8)} ${r.status.padEnd(7)} ` +
      `${String(r.credits).padStart(3)} credits ${String(r.bytes).padStart(9)} bytes ${(r.ms / 1000).toFixed(1)}s${flag}`,
  );
}
console.log(
  `total        ${String(passCredits).padStart(3)} credits for one full pass ` +
    `(${reports.filter((r) => r.status === 'ok').length} ok, ` +
    `${reports.filter((r) => r.status === 'empty').length} empty, ` +
    `${reports.filter((r) => r.status === 'failed').length} failed)`,
);
if (shared) {
  console.log(
    `fetcher      ${String(creditsTotal).padStart(3)} credits counted by the fetch layer ` +
      `(refusals are thrown BEFORE the counter increments; Bright Data may still bill them)`,
  );
}

const ceiling = readCreditCeiling();
console.log('\n--- what it implies for 30 companies ---------------------------------');
console.log(`onboarding all ${N} once:        ~${passCredits * N} credits (one full pass each)`);
console.log(
  `steady state at CADENCE:       ~${dailyCredits * N} credits/day ` +
    `+ ~${(weeklyCredits * N) / 7 | 0}/day averaged for the weekly pair ` +
    `(~${(7 * dailyCredits + weeklyCredits) * N} credits/week)`,
);
if (ceiling !== undefined) {
  console.log(
    `ceiling ${ceiling}:            ~${Math.floor(ceiling / Math.max(passCredits, 1))} full passes, ` +
      `or ~${Math.floor(ceiling / Math.max(dailyCredits * N, 1))} day(s) of daily cadence for all ${N}`,
  );
}
if (live) {
  const spent = reports.reduce((n, r) => n + r.credits, 0);
  console.log(`\nthis run spent ${spent} credit(s) live; cassettes recorded under fixtures/cassettes.`);
} else {
  console.log(
    '\nreplay counts FETCHES, not dollars: each fixture call is counted as the 1 credit ' +
      'a live call would cost. Item content is the recorded capture, not this company.',
  );
}
