/**
 * The orchestrator, as a running process.
 *
 * Everything else in this repo is a one-shot script. This is the long-lived
 * loop the architecture describes -- "one long-lived workspace, once a minute"
 * -- and without it the system is not a system: a deal saved at intake sits
 * `unresolved` forever, because resolution is triggered by this loop polling
 * and by nothing else. A new user adds an agreement, nothing happens, and the
 * only way forward is recording the company by hand.
 *
 *   npx vite-node scripts/run-orchestrator.ts                  # replay: resolves only what is already recorded
 *   npx vite-node scripts/run-orchestrator.ts -- --live        # resolution fetches for real (spends credits)
 *   npx vite-node scripts/run-orchestrator.ts -- --collect     # also run due collection batches
 *   npx vite-node scripts/run-orchestrator.ts -- --once        # a single tick, then exit
 *
 * Collection is OPT-IN. Resolution costs a couple of credits per deal; a
 * collection tick across the enabled universe costs ~13 per company, and a loop
 * left running with --collect would work through the budget on its own. The
 * credit ceiling is enforced regardless, and checked before scheduling rather
 * than after spending.
 */
import { DonnaStore } from '@donna/store';
import {
  runLoop, tick, resolvePending, openCorporatesCandidates,
  makeJudge, clientFromEnv, judgeModel,
} from '@donna/orchestrator';
import { BrightDataFetcher, assertLiveEnv, resolveFetchMode } from '@donna/fetch';
import { loadEnv, requireEnv } from './lib/env.js';

const argv = process.argv.slice(2);
const COLLECT = argv.includes('--collect');
const ONCE = argv.includes('--once');
const LIVE = argv.includes('--live');

loadEnv();
const uri = requireEnv(process.env, 'MONGODB_URI', 'the orchestrator writes to the live book');
const database = requireEnv(process.env, 'MONGODB_DATABASE', 'the orchestrator needs a database name');
const bookId = requireEnv(process.env, 'DONNA_BOOK_ID', 'every document the loop writes carries this book id');
const ceiling = Number(requireEnv(process.env, 'DONNA_CREDIT_CEILING', 'a loop with no ceiling is how a budget disappears'));

const store = await DonnaStore.connect({ uri, database, bookId });
await store.ensureIndexes();

// Fetching is opt-in, and the default is not harmless-but-useless: candidate
// lookups are keyed by URL + UTC DAY, so inheriting DONNA_FETCH_MODE=replay
// means every lookup misses its cassette the moment the UTC day turns over and
// every deal is parked for review. --live is the explicit opt-in; `record`
// rather than `live` so today's lookups become tomorrow's free replay.
if (LIVE) assertLiveEnv(process.env, 'record');
const fetcher = new BrightDataFetcher(LIVE ? { mode: 'record', writeThrough: true } : {});
if (!LIVE && resolveFetchMode() === 'replay') {
  console.log(
    'NOTE: replay mode -- candidate lookups will only succeed for URLs already recorded ' +
      'for today\'s UTC day. Everything else is parked as needs_review. Pass --live to fetch.\n',
  );
}
const candidates = openCorporatesCandidates({
  unlocker: async (url) => { const r = await fetcher.unlocker(url); return { body: r.body, url: r.url }; },
  serp: async (q) => { const r = await fetcher.serpResults(q); return { body: r.body, url: r.url }; },
  log: (e, d) => console.log(`  [candidates] ${e}`, d ?? ''),
});

// No Anthropic key means no judgement, and no judgement means needs_review --
// which is the path the review list already renders. The product degrades to
// asking a person, never to a guess.
const judgeClient = clientFromEnv();
if (!judgeClient) {
  console.log('NOTE: no ANTHROPIC_API_KEY. Deals will be parked for human review rather than matched.\n');
} else {
  console.log(`judge: ${judgeModel()}\n`);
}
const judge = makeJudge(judgeClient);

const log = (event: string, detail?: Record<string, unknown>) =>
  console.log(`[${new Date().toISOString()}] ${event}`, detail ?? '');

const deps = {
  store: store as never,
  creditCeiling: ceiling,
  log,
  resolvePending: async () => {
    const r = await resolvePending({ store: store as never, candidates, judge, limit: 10, log });
    if (r.considered > 0) {
      log('resolution', { considered: r.considered, resolved: r.resolved, needs_review: r.needs_review, failed: r.failed });
    }
    return r.resolved;
  },
  // Collection is opt-in; without it the loop still resolves, reaps and
  // backfills schedules, which is what makes onboarding work.
  runBatch: COLLECT
    ? async (companyId: string, sources: readonly string[]) => {
        log('batch_skipped_not_wired', { company_id: companyId, sources: sources.length });
        return 0;
      }
    : async () => 0,
};

console.log(
  `orchestrator up | book=${bookId} | ceiling=${ceiling} | collect=${COLLECT} | fetch=${fetcher.mode}\n`,
);

if (ONCE) {
  console.log(JSON.stringify(await tick(deps), null, 1));
  await store.close();
} else {
  const ac = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => { console.log(`\n${sig} -- stopping after this tick`); ac.abort(); });
  }
  await runLoop(deps, { signal: ac.signal });
  await store.close();
}
