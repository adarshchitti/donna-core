import { SOURCES, batchId, utcDay, isoNow, type Source } from '@donna/contracts';

/**
 * The orchestrator loop. One long-lived workspace, once a minute, five things in
 * order. There is no cron daemon and no queue system: this loop IS the
 * scheduler, and changing cadence is editing a document.
 *
 * The order matters and is not arbitrary:
 *   1. reap   -- before anything else, so a crashed run from a previous process
 *                is cleaned up and its schedule freed. This is what makes a
 *                restart recover by itself. It also disables schedules whose
 *                bounded lookup watch has ended.
 *   2. resolve -- unresolved deals become companies, and resolution writes
 *                schedules with next_run_at: now, so a newly resolved company's
 *                first batch fires on the NEXT tick. That first batch is the
 *                profile.
 *   2b. lookup -- one pre-deal lookup intent (a company with `lookup` set and
 *                no last_checked_at) is resolved and collected once. After
 *                resolve, so the deal path -- the user's real agreements --
 *                is never queued behind a prospect; before schedule, so a
 *                lookup's eight fetches are counted before due work spends
 *                against the ceiling, and its company is never mistaken for
 *                one needing schedules backfilled.
 *   3. schedule -- due schedules grouped BY COMPANY into a batch, because the
 *                validator needs every source for one company, not one source
 *                for every company.
 *   4. fold   -- when the batch's last job ends, ok or failed, the differ runs
 *                over the batch and the validator runs ONCE.
 */

export const LOOP_INTERVAL_MS = 60_000;
export const STALE_RUN_MINUTES = 10;

/** Primary and reported sources daily; inferred weekly. Nothing hourly. */
export const CADENCE: Record<Source, 'daily' | 'weekly'> = {
  registry: 'daily', court: 'daily', regulator: 'daily', layoffs: 'daily',
  news: 'daily', executives: 'daily',
  jobs: 'weekly', domain: 'weekly',
};

export interface LoopDeps {
  store: {
    reapStaleRuns(minutes?: number): Promise<{ reaped: number } | unknown>;
    /** Turns off schedules whose lookup watch has ended -- part of step 1. */
    disableExpiredSchedules?(now?: string | Date): Promise<number>;
    dueSchedules(now?: string | Date): Promise<Array<{ company_id: string; source: Source }>>;
    creditsSpentTotal(): Promise<number>;
    listCompanies(): Promise<Array<{ company_id: string }>>;
    /** Companies with no schedules at all -- see step 3 in tick(). */
    companiesWithoutSchedules?(limit?: number): Promise<Array<{ company_id: string }>>;
    upsertSchedule?(input: {
      company_id: string; source: Source; cadence: 'daily' | 'weekly';
      next_run_at: string; enabled?: boolean;
    }): Promise<void>;
  };
  /** Runs every job for one company and folds the batch. Returns jobs attempted. */
  runBatch(companyId: string, sources: Source[], batch: string): Promise<number>;
  /** Picks up deals with status 'unresolved'. Returns how many it resolved. */
  resolvePending(): Promise<number>;
  /** Runs at most ONE lookup intent. Returns how many it collected (0 or 1). */
  lookupPending?(): Promise<number>;
  creditCeiling: number;
  now?: () => Date;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface TickResult {
  reaped: number;
  /** Schedules disabled because their lookup watch ended. */
  expired: number;
  resolved: number;
  /** Lookup intents collected this tick (at most one). */
  looked_up: number;
  /** Companies that had no schedules and were given them this tick. */
  scheduled: number;
  batches: number;
  jobs: number;
  credits_spent: number;
  /** True when the ceiling stopped us scheduling. Surfaced on the book view. */
  credit_ceiling_hit: boolean;
}

/** One pass. Separated from the interval so it can be tested without timers. */
export async function tick(deps: LoopDeps): Promise<TickResult> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());

  // 1. Reap. A run stuck in `started` for more than ten minutes is treated as
  // failed and its schedule pushed. Because this runs first and on every tick, a
  // process that dies mid-batch does not wedge the company forever.
  const reapRaw = await deps.store.reapStaleRuns(STALE_RUN_MINUTES);
  const reaped = typeof reapRaw === 'object' && reapRaw !== null && 'reaped' in reapRaw
    ? Number((reapRaw as { reaped: unknown }).reaped) || 0
    : 0;
  if (reaped > 0) log('reaped', { runs: reaped });
  // An ended watch is switched off rather than filtered out of every tick
  // forever. dueSchedules() also refuses expired schedules, so this is tidiness
  // and visibility, not the only guard.
  const expired = deps.store.disableExpiredSchedules
    ? await deps.store.disableExpiredSchedules(now())
    : 0;
  if (expired > 0) log('watch_expired', { schedules: expired });

  // 2. Resolve. Intake only writes status: unresolved; nothing else triggers
  // resolution, so the loop has to poll for it.
  const resolved = await deps.resolvePending();
  if (resolved > 0) log('resolved', { deals: resolved });

  // 2b. Lookup. The surface cannot call a collector, so a pre-deal lookup is an
  // intent document the loop polls for, exactly like an unresolved deal. One
  // per tick and never batched: each is a full pass, and runLookup checks its
  // own ceiling before fetching. A throw here must not stop due monitoring.
  let looked_up = 0;
  if (deps.lookupPending) {
    try {
      looked_up = await deps.lookupPending();
    } catch (error) {
      log('lookup_failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // 3. Backfill schedules.
  //
  // Collection used to start ONLY as a side effect of automated resolution, so
  // a company added by hand -- Track C's "add company" path, or a deal created
  // with an existing company already picked -- sat in the book with no
  // schedules and was never collected. It looked monitored and was inert.
  //
  // Rather than patch the paths that create companies, the loop converges on
  // the invariant: every company has schedules, and anything missing them gets
  // them on the next tick. A new path can be added without remembering this.
  //
  // next_run_at is NOW, so a hand-added company's first batch fires on the
  // following tick -- and that first batch is its profile, not an alert.
  let scheduled = 0;
  if (deps.store.companiesWithoutSchedules && deps.store.upsertSchedule) {
    const orphans = await deps.store.companiesWithoutSchedules(25);
    const now = isoNow();
    for (const company of orphans) {
      for (const source of SOURCES) {
        await deps.store.upsertSchedule({
          company_id: company.company_id, source, cadence: CADENCE[source],
          next_run_at: now, enabled: true,
        });
      }
      scheduled += 1;
      log('scheduled_backfill', { company_id: company.company_id });
    }
  }

  // 4. Credit ceiling, checked BEFORE scheduling rather than after spending.
  // There are 300 credits for the whole event and a bad loop could spend them
  // before lunch, so the ceiling stops new work instead of reporting the damage.
  const credits_spent = await deps.store.creditsSpentTotal();
  if (credits_spent >= deps.creditCeiling) {
    log('credit_ceiling_hit', { credits_spent, ceiling: deps.creditCeiling });
    return {
      reaped, expired, resolved, looked_up, scheduled,
      batches: 0, jobs: 0, credits_spent, credit_ceiling_hit: true,
    };
  }

  // 5. Group due work by company. One batch per company, so the validator sees
  // a whole company at once and narrates it once.
  const due = await deps.store.dueSchedules(now());
  const byCompany = new Map<string, Source[]>();
  for (const s of due) {
    const list = byCompany.get(s.company_id) ?? [];
    if (SOURCES.includes(s.source)) list.push(s.source);
    byCompany.set(s.company_id, list);
  }

  const day = utcDay();
  let jobs = 0;
  let batches = 0;
  for (const [companyId, sources] of byCompany) {
    if (sources.length === 0) continue;
    const batch = batchId(companyId, day);
    try {
      jobs += await deps.runBatch(companyId, sources, batch);
      batches += 1;
    } catch (error) {
      // One company's batch failing must never stop the others. The failure is
      // already recorded in collector_runs by runBatch; here we only keep going.
      log('batch_failed', {
        company_id: companyId,
        batch,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log('tick', { reaped, expired, resolved, looked_up, scheduled, batches, jobs, credits_spent, at: isoNow() });
  return {
    reaped, expired, resolved, looked_up, scheduled, batches, jobs, credits_spent, credit_ceiling_hit: false,
  };
}

/** Long-running driver. Never overlaps ticks, and never dies on one bad tick. */
export async function runLoop(
  deps: LoopDeps,
  opts: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const interval = opts.intervalMs ?? LOOP_INTERVAL_MS;
  const log = deps.log ?? (() => {});
  while (!opts.signal?.aborted) {
    const startedAt = Date.now();
    try {
      await tick(deps);
    } catch (error) {
      // The loop is the only thing keeping collection alive, so it survives
      // anything a single tick can throw.
      log('tick_failed', { error: error instanceof Error ? error.message : String(error) });
    }
    const elapsed = Date.now() - startedAt;
    await sleep(Math.max(0, interval - elapsed), opts.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms === 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
