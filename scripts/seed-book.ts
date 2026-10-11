/**
 * seed-book -- put the fixed 30-company Ohio universe into the book.
 *
 *   npx vite-node scripts/seed-book.ts            # DRY RUN (default): prints, writes nothing
 *   npx vite-node scripts/seed-book.ts --commit   # writes via DonnaStore
 *
 * Writes go through DonnaStore and ONLY DonnaStore: it stamps book_id on every
 * document, validates each write against the zod contracts before it reaches
 * Mongo, and creates indexes with specs byte-identical to Track C's (a
 * mismatch is IndexOptionsConflict, which the backend swallows into a 503 that
 * breaks ALL of its writes).
 *
 * Idempotency. upsertCompany keys on {book_id, jurisdiction, registry_key} and
 * all 30 seeds have no registry_id, so their registry_key is MANUAL:<uuid> --
 * a fresh random key on every run, which means the store's own key CANNOT find
 * a company we seeded before. So manual companies are matched by name instead:
 * a company already in the book under this canonical name (or alias) is
 * reported 'exists' and reused, never duplicated. When a seed does carry a
 * registry_id, upsertCompany is called with the existing company_id, which is
 * exactly the store's documented MANUAL->registry backfill path. Schedules are
 * upserts on {book_id, company_id, source} and are naturally idempotent.
 */
import { SOURCES, isoNow, utcDay, type Company } from '@donna/contracts';
import { DonnaStore, sameName } from '@donna/store';
import { CADENCE } from '../packages/orchestrator/src/loop.js';
import { UsageError, flagValue, loadEnv, requireEnv } from './lib/env.js';
import { OHIO_COMPANIES_PATH, loadOhioCompanies, type SeedCompany } from './lib/ohio.js';

const usage = (): never => {
  console.error(
    'usage: npx vite-node scripts/seed-book.ts [--commit] [--companies <path>] [--env <path>]\n' +
      '  default is --dry-run: prints the planned writes and touches nothing.\n' +
      '  --commit writes through DonnaStore (needs MONGODB_URI, MONGODB_DATABASE, DONNA_BOOK_ID).',
  );
  process.exit(2);
};

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) usage();
const commit = argv.includes('--commit');
const envPath = flagValue(argv, '--env');
const companiesPath = flagValue(argv, '--companies') ?? OHIO_COMPANIES_PATH;

loadEnv(envPath);

// The book id decides whether every document is visible or invisible. It is
// required even for a dry run because printing "what we would write" includes
// which book it would be written to.
const bookId = requireEnv(
  process.env,
  'DONNA_BOOK_ID',
  'book_id scopes every document; a wrong one makes the seed invisible to the UI with no error',
);

const seeds = loadOhioCompanies(companiesPath);
const now = isoNow();
const today = utcDay();

const scheduleSummary = SOURCES.map((s) => `${s}:${CADENCE[s]}`).join(' ');

if (!commit) {
  console.log(`DRY RUN -- nothing will be written. Re-run with --commit to write.`);
  console.log(`book_id: ${bookId}`);
  console.log(`companies: ${seeds.length} from ${companiesPath}`);
  console.log(`schedules per company: ${SOURCES.length} (${scheduleSummary}), next_run_at = now`);
  console.log('');
  for (const [i, s] of seeds.entries()) {
    const key = s.registry_id ? s.registry_id.toUpperCase() : 'MANUAL:<uuid>';
    console.log(
      `  ${String(i + 1).padStart(2)}. ${s.canonical_name} [${s.jurisdiction} ${key}]` +
        ` domains=${s.domains.join(',') || '-'} aliases=${s.aliases.length}`,
    );
  }
  console.log('');
  console.log(
    `would write: ${seeds.length} companies + ${seeds.length * SOURCES.length} schedules ` +
      `(upsert; idempotent on a re-run)`,
  );
  process.exit(0);
}

// --- --commit ---------------------------------------------------------------

const uri = requireEnv(process.env, 'MONGODB_URI', 'the --commit seed writes to MongoDB');
const database = requireEnv(process.env, 'MONGODB_DATABASE', 'the --commit seed needs a database name');

const store = await DonnaStore.connect({ uri, database, bookId });

const findByName = (
  existing: readonly Company[],
  seed: SeedCompany,
): Company | undefined =>
  existing.find(
    (c) =>
      sameName(c.canonical_name, seed.canonical_name)
      || (c.aliases ?? []).some((a) => sameName(a, seed.canonical_name)),
  );

const outcomes: Record<string, number> = {};
const bump = (k: string): void => {
  outcomes[k] = (outcomes[k] ?? 0) + 1;
};

try {
  const existing = await store.listCompanies();
  console.log(
    `COMMIT -- ${seeds.length} companies into ${database} for book ${bookId}. ` +
      `${existing.length} companies already in the book.`,
  );

  for (const [i, seed] of seeds.entries()) {
    const found = findByName(existing, seed);
    let companyId: string;
    let outcome: string;

    if (found && seed.registry_id === '') {
      // MANUAL:<uuid> keys are random per upsert, so calling upsertCompany
      // again would INSERT a second document. The already-seeded company is
      // the right one; reuse it.
      companyId = found.company_id;
      outcome = 'exists';
    } else {
      const res = await store.upsertCompany({
        // Present only when we matched by name and the seed now has a real
        // registry id: the store's documented MANUAL -> registry backfill path.
        ...(found ? { company_id: found.company_id } : {}),
        canonical_name: seed.canonical_name,
        jurisdiction: seed.jurisdiction,
        registry_id: seed.registry_id,
        aliases: seed.aliases,
        domains: seed.domains,
        resolution: {
          confidence: null,
          reason:
            'Seeded from donna-collectors/ohio-companies.json (the fixed Ohio ' +
            'universe). registry_id unverified at seed time.',
          resolved_by: 'seed-book',
        },
        monitoring_since: today,
      });
      companyId = res.company_id;
      outcome = res.outcome;
    }
    bump(outcome);

    // One schedule per (company, source). next_run_at = now so the first batch
    // fires on the next tick -- and that first batch is the profile.
    for (const source of SOURCES) {
      await store.upsertSchedule({
        company_id: companyId,
        source,
        cadence: CADENCE[source],
        next_run_at: now,
        enabled: true,
      });
    }

    console.log(
      `  ${String(i + 1).padStart(2)}/${seeds.length} ${seed.canonical_name} -> ${companyId} ` +
        `${outcome} (+${SOURCES.length} schedules)`,
    );
  }

  const summary = Object.entries(outcomes)
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
  console.log(
    `\ndone: ${seeds.length} companies (${summary}), ${seeds.length * SOURCES.length} schedules upserted.`,
  );
} finally {
  await store.close();
}
