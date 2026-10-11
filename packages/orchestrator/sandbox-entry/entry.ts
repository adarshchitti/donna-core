/**
 * THE SANDBOX ENTRY POINT.
 *
 * This is the only code that runs inside a throwaway sandbox. It is bundled
 * with the collectors into one self-contained file, uploaded, and executed.
 *
 * Why collection runs here rather than in the orchestrator: this process parses
 * arbitrary HTML fetched from the open web. That is exactly the code that should
 * not sit next to the database. The sandbox has no MongoDB credential and no
 * network reach beyond Bright Data -- the orchestrator holds every secret and
 * hands each job only what it needs.
 *
 * Contract with the orchestrator, deliberately as narrow as possible:
 *   in   <- DONNA_JOB_INPUT env var, JSON: {company, source, runId}
 *   out  -> one line of JSON on stdout: {ok, envelope} or {ok: false, error}
 * Nothing else on stdout. Diagnostics go to stderr, which is captured into the
 * run record so a failure is never silent.
 */
import { collectors, LiveFetcher, type Source, type CanonicalCompany, type Fetcher, type FetchResult } from 'donna-collectors';

/**
 * Bytes the orchestrator already fetched, keyed `unlocker:<url>` or `serp:<query>`.
 * Each entry carries the instant the bytes were actually obtained, because that
 * is what the evidence page shows -- not the time the sandbox parsed them.
 */
export type PrefetchMap = Record<string, { body: string; url: string; fetched_at: string; credits_spent?: number }>;

/**
 * Serves prefetched bytes. Implements the same Fetcher interface the collectors
 * take, so a collector cannot tell whether it is fetching or replaying -- and
 * therefore cannot behave differently on stage than it does in a test.
 *
 * A miss throws rather than returning empty: a collector must never silently
 * report "nothing found" for a page nobody actually fetched.
 */
class PrefetchedFetcher implements Fetcher {
  constructor(private readonly map: PrefetchMap) {}
  async unlocker(url: string): Promise<FetchResult> { return this.take(`unlocker:${url}`, url); }
  async serp(query: string): Promise<FetchResult> { return this.take(`serp:${query}`, query); }
  private take(key: string, what: string): FetchResult {
    const hit = this.map[key];
    if (!hit) {
      throw new Error(
        `no prefetched bytes for ${key}. The orchestrator must fetch ${what} before ` +
        `handing the job to the sandbox; the sandbox has no network by design.`,
      );
    }
    return {
      body: hit.body, url: hit.url, fetched_at: hit.fetched_at,
      credits_spent: hit.credits_spent ?? 0, cache_hit: true,
    };
  }
}

interface JobInput {
  company: CanonicalCompany;
  source: Source;
  runId: string;
}

async function main(): Promise<void> {
  const raw = process.env.DONNA_JOB_INPUT;
  if (!raw) throw new Error('DONNA_JOB_INPUT is not set; the orchestrator must supply the job');

  const job = JSON.parse(raw) as JobInput;
  const collect = collectors[job.source];
  if (!collect) throw new Error(`no collector for source '${job.source}'`);

  // Two modes, and REPLAY IS THE DEFAULT -- deliberately.
  //
  // The dangerous operation here is not fetching, it is PARSING: turning
  // arbitrary attacker-controlled HTML into structured items. So the preferred
  // shape is for the orchestrator to fetch (it holds the Bright Data key and
  // the network path) and hand the raw bytes to the sandbox to parse, with the
  // sandbox given NO credential and NO egress at all. That is strictly stronger
  // isolation than handing a sandbox a key and an open network.
  //
  // It is also what works: Daytona sandboxes have no outbound network on this
  // account -- DNS resolves but every TLS connection is reset, even with
  // networkAllowList set to 0.0.0.0/0, so the restriction is account-level.
  // Live mode remains for an environment where egress is available.
  const prefetched = process.env.DONNA_JOB_FETCHES;
  let fetcher;
  if (prefetched) {
    fetcher = new PrefetchedFetcher(JSON.parse(prefetched) as PrefetchMap);
  } else {
    const apiKey = process.env.BRIGHTDATA_API_KEY;
    if (!apiKey) {
      throw new Error(
        'no DONNA_JOB_FETCHES supplied and BRIGHTDATA_API_KEY is not set: the sandbox ' +
        'has neither prefetched bytes to parse nor a way to fetch them',
      );
    }
    // Named explicitly rather than defaulted to '': an empty zone turns into
    // a per-source config error inside the sandbox, which comes back as a
    // failed envelope and reads like a fetch failure.
    const unlockerZone = process.env.BRIGHTDATA_UNLOCKER_ZONE;
    const serpZone = process.env.BRIGHTDATA_SERP_ZONE;
    if (!unlockerZone || !serpZone) {
      throw new Error(
        'live sandbox fetching needs BRIGHTDATA_UNLOCKER_ZONE and BRIGHTDATA_SERP_ZONE; ' +
        `got ${unlockerZone ? 'serp zone' : 'unlocker zone'} missing. The orchestrator ` +
        'forwards both in the job env.',
      );
    }
    fetcher = new LiveFetcher({ apiKey, unlockerZone, serpZone });
  }

  // A collector never throws by contract, but the entry point must not depend
  // on that: a crash here would come back as an empty stdout, which the
  // orchestrator would have to interpret. So it is caught and reported.
  const envelope = await collect(job.company, {
    fetcher,
    now: () => new Date().toISOString(),
    runId: job.runId,
  });

  process.stdout.write(JSON.stringify({ ok: true, envelope }));
}

main().catch((error: unknown) => {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  // Non-zero so the orchestrator can distinguish "collector reported failure"
  // from "the sandbox itself fell over".
  process.exitCode = 1;
});
