import { randomUUID } from 'node:crypto';
import { MongoClient, type Collection, type Db, type Document, type Filter } from 'mongodb';
import {
  briefingSchema, changeSchema, clusterSchema, collectorRunSchema, companySchema,
  coverageSchema, scheduleSchema, signalSchema, snapshotSchema,
  isoNow, signalId as makeSignalId, fetchCacheKey, parseLatestSnapshotAlias, SOURCES,
  type Briefing, type Cluster, type Company, type CollectorRun, type Coverage,
  type Deal, type Schedule, type Signal, type Snapshot, type Source,
} from '@donna/contracts';
import {
  AUTO_RESOLVER, COLLECTIONS, FETCH_CACHE_TTL_HOURS, MANUAL_REGISTRY_PREFIX, SIGNAL_WINDOW_DAYS,
  STALE_RUN_MINUTES,
} from './constants.js';
import { ALL_INDEXES, ensureIndexes, type IndexDef } from './indexes.js';
import { StoreError, validate } from './validate.js';
import {
  addDays, contentHash, isDuplicateKeyError, isManualRegistryKey, registryKeyFor,
  sameName, toUtcDay, toUtcInstant, uniqueStrings,
} from './util.js';
import {
  fetchCacheEntrySchema,
  type BackfillOutcome, type BriefingInput, type ChangeInput, type ClusterInput,
  type CompanyUpsertInput, type CompanyUpsertResult, type PutCachedOptions,
  type ReapResult, type ResolutionInput, type RunFinishPatch, type RunHandle,
  type RunStartInput, type ScheduleInput, type SignalInput, type SignalUpsertResult,
  type SnapshotInput, type SnapshotInsertResult,
} from './types.js';

export interface DonnaStoreOptions {
  uri: string;
  database: string;
  /** A Base44 user id. Every document we write is stamped with it. */
  bookId: string;
  /** Default true. Pass false only if another process is known to have run it. */
  ensureIndexes?: boolean;
}

/** Confidence rank, so corroboration can only ever raise confidence. */
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

/**
 * The only way this codebase talks to MongoDB.
 *
 * It exposes intentions (`upsertCompany`, `setCoverage`, `latestOkSnapshot`)
 * rather than collections, because the dangerous mistakes here are not "wrong
 * query" but "right query, wrong write shape". A Base44 app reads this same
 * database; it filters every read on `{book_id: user.id}` and renders whatever
 * it finds. So a missing `book_id`, a `canonical_name` rewrite or a coverage
 * field parked in `$setOnInsert` does not raise -- it blanks a screen. Each
 * method below exists to make one of those impossible to express.
 */
export class DonnaStore {
  readonly bookId: string;
  readonly db: Db;
  private readonly client: MongoClient;
  private readonly ownsClient: boolean;

  private constructor(client: MongoClient, db: Db, bookId: string, ownsClient: boolean) {
    assertBookId(bookId);
    this.client = client;
    this.db = db;
    this.bookId = bookId;
    this.ownsClient = ownsClient;
  }

  static async connect(opts: DonnaStoreOptions): Promise<DonnaStore> {
    assertBookId(opts.bookId);
    if (!opts.uri) throw new StoreError('DonnaStore requires a `uri`.');
    if (!opts.database) throw new StoreError('DonnaStore requires a `database`.');
    const client = new MongoClient(opts.uri);
    await client.connect();
    const store = new DonnaStore(client, client.db(opts.database), opts.bookId, true);
    if (opts.ensureIndexes !== false) await store.ensureIndexes();
    return store;
  }

  /** For callers that already own a MongoClient (tests, a shared pool). */
  static fromClient(
    client: MongoClient,
    opts: { database: string; bookId: string },
  ): DonnaStore {
    assertBookId(opts.bookId);
    if (!opts.database) throw new StoreError('DonnaStore requires a `database`.');
    return new DonnaStore(client, client.db(opts.database), opts.bookId, false);
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.client.close();
  }

  /** Idempotent. See indexes.ts for why the specs are byte-identical to Track C's. */
  ensureIndexes(defs: readonly IndexDef[] = ALL_INDEXES): Promise<void> {
    return ensureIndexes(this.db, defs);
  }

  // =========================================================================
  // internals
  // =========================================================================

  private col(name: string): Collection<Document> {
    return this.db.collection(name);
  }

  private get companies(): Collection<Document> { return this.col(COLLECTIONS.companies); }
  private get deals(): Collection<Document> { return this.col(COLLECTIONS.deals); }
  private get snapshots(): Collection<Document> { return this.col(COLLECTIONS.snapshots); }
  private get changes(): Collection<Document> { return this.col(COLLECTIONS.changes); }
  private get signals(): Collection<Document> { return this.col(COLLECTIONS.signals); }
  private get clusters(): Collection<Document> { return this.col(COLLECTIONS.clusters); }
  private get briefings(): Collection<Document> { return this.col(COLLECTIONS.briefings); }
  private get runs(): Collection<Document> { return this.col(COLLECTIONS.collectorRuns); }
  private get schedules(): Collection<Document> { return this.col(COLLECTIONS.schedules); }
  private get fetchCache(): Collection<Document> { return this.col(COLLECTIONS.fetchCache); }

  /**
   * EVERY filter in this file goes through here. Rule 1's read half: a query
   * that forgets `book_id` reads another tenant's documents, and the result
   * looks perfectly plausible.
   */
  private scope(extra: Document = {}): Filter<Document> {
    if ('book_id' in extra) {
      throw new StoreError('Do not pass book_id in a filter; the store scopes every query.');
    }
    return { book_id: this.bookId, ...extra } as Filter<Document>;
  }

  /** Rule 1's write half. The book id comes from the store, never from input. */
  private stamp<T extends object>(doc: T): T & { book_id: string } {
    if ('book_id' in doc) {
      throw new StoreError(
        'Do not pass book_id in a write input; the store stamps it. '
        + `(store bookId = ${JSON.stringify(this.bookId)})`,
      );
    }
    return { ...doc, book_id: this.bookId };
  }

  // =========================================================================
  // companies
  // =========================================================================

  /**
   * Upsert a company on Track C's unique key {book_id, jurisdiction, registry_key}.
   *
   * Three rules are enforced here:
   *
   *  - rule 4, canonical_name is NEVER rewritten. Track C returns 409 on a
   *    case-insensitive canonical_name mismatch when the user adds a company,
   *    so renaming a company from our side breaks their next "Add company" with
   *    a conflict they cannot clear. A different incoming name becomes an entry
   *    in `aliases[]` via `$addToSet`.
   *
   *  - identity fields go in `$setOnInsert`, mirroring Track C exactly, because
   *    Track C creates `companies` documents ONLY with `$setOnInsert`.
   *
   *  - `coverage` and `resolution` are deliberately not updatable here; see
   *    setCoverage / setResolution and rule 3.
   */
  async upsertCompany(input: CompanyUpsertInput): Promise<CompanyUpsertResult> {
    // The input type has no book_id, but JS callers exist; fail loudly rather
    // than silently dropping it (rule 1).
    if ('book_id' in input) {
      throw new StoreError(
        'Do not pass book_id to upsertCompany; the store stamps it. '
        + `(store bookId = ${JSON.stringify(this.bookId)})`,
      );
    }
    const registryId = (input.registry_id ?? '').trim();
    const companyId = input.company_id ?? randomUUID();

    // Backfill detection (rule 7). If we were handed a company_id that already
    // exists with a MANUAL: key and we now have a real registry id, this is not
    // an upsert at all -- it is an identity change on the unique index, which
    // can collide. Delegate to the explicit merge path.
    if (input.company_id && registryId) {
      const byId = await this.companies.findOne(this.scope({ company_id: input.company_id }));
      if (byId && isManualRegistryKey(String(byId.registry_key ?? ''))) {
        const merged = await this.backfillRegistryId(input.company_id, registryId);
        if (merged.outcome !== 'noop') {
          // Fold the non-identity parts of this call onto the surviving document.
          await this.addAliasesAndDomains(merged.company_id, input);
          return { company_id: merged.company_id, outcome: merged.outcome };
        }
      }
    }

    const registryKey = registryKeyFor(registryId, randomUUID);
    const key = this.scope({ jurisdiction: input.jurisdiction, registry_key: registryKey });

    const existing = await this.companies.findOne(key);
    if (existing) return this.updateExistingCompany(existing as unknown as Company, input);

    // Validate the whole intended document before anything reaches Mongo, so a
    // contract violation is a useful error here rather than a blank screen in
    // Track C.
    const intended = validate('companies', companySchema, this.stamp({
      company_id: companyId,
      canonical_name: input.canonical_name,
      jurisdiction: input.jurisdiction,
      registry_id: registryId,
      registry_key: registryKey,
      aliases: uniqueStrings(input.aliases ?? []),
      domains: uniqueStrings(input.domains ?? []),
      officers: input.officers ?? [],
      related_entities: input.related_entities ?? [],
      resolution: {
        confidence: input.resolution?.confidence ?? null,
        reason: input.resolution?.reason ?? '',
        resolved_by: input.resolution?.resolved_by ?? null,
        candidates_seen: input.resolution?.candidates_seen ?? [],
        ...(input.resolution?.resolved_at
          ? { resolved_at: toUtcInstant(input.resolution.resolved_at) }
          : {}),
      },
      ...(input.last_checked_at ? { last_checked_at: toUtcInstant(input.last_checked_at) } : {}),
      ...(input.monitoring_since ? { monitoring_since: input.monitoring_since } : {}),
      // A lookup is identity-time context (who asked, before which signature),
      // so like the identity fields it is written on insert only. A company
      // that already exists keeps the history it has.
      ...(input.lookup
        ? {
            lookup: {
              requested_at: toUtcInstant(input.lookup.requested_at),
              requested_by: input.lookup.requested_by,
              watch_until: input.lookup.watch_until,
            },
          }
        : {}),
    }));

    // `$setOnInsert` only -- same shape Track C uses, so a concurrent Track C
    // upsert of the same key is a harmless no-op either way round.
    const result = await this.companies.updateOne(key, { $setOnInsert: intended }, { upsert: true });

    if (result.upsertedCount === 0) {
      // Someone (Track C, or another worker) created it between our findOne and
      // our upsert. Fall through to the update path so our aliases are not lost.
      const now = await this.companies.findOne(key);
      if (now) return this.updateExistingCompany(now as unknown as Company, input);
    }
    return { company_id: intended.company_id, outcome: 'inserted' };
  }

  private async updateExistingCompany(
    existing: Company,
    input: CompanyUpsertInput,
  ): Promise<CompanyUpsertResult> {
    const update: Document = {};

    // rule 4: a different name is an alias, not a rename.
    const aliasAdds = uniqueStrings([
      ...(input.aliases ?? []),
      ...(sameName(existing.canonical_name, input.canonical_name) ? [] : [input.canonical_name]),
    ]).filter((a) => !sameName(a, existing.canonical_name));
    const domainAdds = uniqueStrings(input.domains ?? []);

    const addToSet: Document = {};
    if (aliasAdds.length) addToSet.aliases = { $each: aliasAdds };
    if (domainAdds.length) addToSet.domains = { $each: domainAdds };
    if (Object.keys(addToSet).length) update.$addToSet = addToSet;

    const set: Document = {};
    if (input.last_checked_at) set.last_checked_at = toUtcInstant(input.last_checked_at);
    // Officers are a fresh observation from the registry collector, so replacing
    // them is correct -- but only when we actually have some. An empty array
    // here would wipe a list Track C entered by hand.
    if (input.officers?.length) set.officers = input.officers;
    if (Object.keys(set).length) update.$set = set;

    if (!Object.keys(update).length) {
      return { company_id: existing.company_id, outcome: 'unchanged' };
    }
    await this.companies.updateOne(this.scope({ company_id: existing.company_id }), update);
    return { company_id: existing.company_id, outcome: 'updated' };
  }

  private async addAliasesAndDomains(
    companyId: string,
    input: CompanyUpsertInput,
  ): Promise<void> {
    const existing = await this.companies.findOne(this.scope({ company_id: companyId }));
    if (!existing) return;
    await this.updateExistingCompany(existing as unknown as Company, input);
  }

  /**
   * Write `companies.coverage` with `$set`. NEVER with `$setOnInsert`.
   *
   * ===== READ THIS BEFORE "SIMPLIFYING" COVERAGE BACK INTO upsertCompany =====
   * Track C creates `companies` documents ONLY with `$setOnInsert`, on the
   * unique key {book_id, jurisdiction, registry_key}. Its "Add company" button
   * therefore issues an upsert against a document that already exists, and
   * every field in a `$setOnInsert` block is DISCARDED on that path.
   *
   * So if coverage lived in a `$setOnInsert` block of ours, the sequence
   *   1. we compute coverage       -> coverage written
   *   2. user re-adds the company  -> Track C upserts with $setOnInsert
   *   3. we "refresh" coverage     -> our $setOnInsert is skipped, nothing changes
   * leaves the Coverage panel showing stale or absent data with no error
   * anywhere. `$set` on an existing document always applies, and Track C's
   * upsert never clears fields it does not mention, so the two coexist.
   * ==========================================================================
   */
  async setCoverage(companyId: string, coverage: Coverage): Promise<void> {
    const valid = validate('companies.coverage', coverageSchema, {
      ...coverage,
      as_of: coverage.as_of ? toUtcInstant(coverage.as_of) : isoNow(),
    });
    const res = await this.companies.updateOne(
      this.scope({ company_id: companyId }),
      { $set: { coverage: valid, last_checked_at: valid.as_of } },
    );
    if (res.matchedCount === 0) {
      throw new StoreError(
        `setCoverage: no company ${JSON.stringify(companyId)} in book ${this.bookId}.`,
      );
    }
  }

  /**
   * Record how a company was resolved. `$set`, for the same reason as coverage.
   *
   * rule 5: anything we resolved without a human carries
   * `resolved_by: 'auto_resolver'` (the AUTO_RESOLVER constant), so an
   * automated guess is always distinguishable from a user's deliberate choice.
   * Pass `resolved_by` explicitly for a human resolution; never overwrite a
   * human value with the sentinel.
   */
  async setResolution(companyId: string, input: ResolutionInput): Promise<void> {
    const resolution = {
      confidence: input.confidence,
      reason: input.reason,
      resolved_by: input.resolved_by ?? AUTO_RESOLVER,
      candidates_seen: input.candidates_seen ?? [],
      resolved_at: isoNow(),
    };
    validate('companies.resolution', companySchema.shape.resolution, resolution);
    const res = await this.companies.updateOne(
      this.scope({ company_id: companyId }),
      { $set: { resolution } },
    );
    if (res.matchedCount === 0) {
      throw new StoreError(
        `setResolution: no company ${JSON.stringify(companyId)} in book ${this.bookId}.`,
      );
    }
  }

  /**
   * rule 7: we discovered a real registry id for a company that was created by
   * hand (registry_key `MANUAL:<uuid>`).
   *
   * The naive fix is `$set: {registry_key: id.toUpperCase()}`. That is wrong.
   * `{book_id, jurisdiction, registry_key}` is UNIQUE, so if another document
   * already owns the target key -- which is exactly what happens when the user
   * added the company by hand and we later resolved the same company properly,
   * or added it twice -- the `$set` fails with E11000. Track C turns that into
   * a 503 and the user sees nothing useful.
   *
   * So we detect the collision explicitly and take one of two paths:
   *
   *  A. CLEAN BACKFILL -- nothing owns the target key. Move this document onto
   *     it: `$set` registry_id/registry_key, keep everything else.
   *
   *  B. MERGE -- a canonical document already owns the target key. The canonical
   *     document WINS (it carries the registry-sourced identity Track C's
   *     uniqueness is built around). We:
   *       1. fold the manual document's aliases/domains onto it ($addToSet; its
   *          canonical_name is NOT copied -- rule 4);
   *       2. repoint every deal linked to the manual company_id at the canonical
   *          company_id, so the user's deals are not orphaned;
   *       3. delete the manual document.
   *
   * Guard: we refuse to merge away a manual company that already has Donna-side
   * artifacts (snapshots/signals), because those are keyed by company_id and
   * their ids embed it -- moving them is a migration, not an upsert, and doing
   * it silently would leave dangling evidence links.
   */
  async backfillRegistryId(companyId: string, registryId: string): Promise<BackfillOutcome> {
    const targetKey = registryId.trim().toUpperCase();
    if (!targetKey) throw new StoreError('backfillRegistryId needs a non-empty registry id.');

    const manual = await this.companies.findOne(this.scope({ company_id: companyId }));
    if (!manual) {
      throw new StoreError(`backfillRegistryId: no company ${JSON.stringify(companyId)}.`);
    }
    const manualKey = String(manual.registry_key ?? '');
    if (manualKey === targetKey) return { outcome: 'noop', company_id: companyId };
    if (!isManualRegistryKey(manualKey)) {
      throw new StoreError(
        `backfillRegistryId refuses to repoint ${JSON.stringify(companyId)}: its registry_key `
        + `${JSON.stringify(manualKey)} is a real registry key, not a MANUAL: placeholder. `
        + 'Changing it would silently detach the company from its registry identity.',
      );
    }

    const canonical = await this.companies.findOne(
      this.scope({ jurisdiction: manual.jurisdiction, registry_key: targetKey }),
    );

    // --- path A: clean backfill ---------------------------------------------
    if (!canonical) {
      await this.companies.updateOne(
        this.scope({ company_id: companyId }),
        { $set: { registry_id: registryId.trim(), registry_key: targetKey } },
      );
      return { outcome: 'backfilled', company_id: companyId, registry_key: targetKey };
    }

    // --- path B: collision, merge into the canonical document ---------------
    const canonicalId = String(canonical.company_id);
    const artifacts = await this.countDonnaArtifacts(companyId);
    if (artifacts > 0) {
      throw new StoreError(
        `backfillRegistryId cannot merge ${JSON.stringify(companyId)} into `
        + `${JSON.stringify(canonicalId)}: the manual company already has ${artifacts} `
        + 'Donna-side document(s) (snapshots/signals) whose ids embed its company_id. '
        + 'Merge those deliberately rather than orphaning their evidence links.',
      );
    }

    const aliasAdds = uniqueStrings([
      ...(Array.isArray(manual.aliases) ? (manual.aliases as string[]) : []),
      String(manual.canonical_name ?? ''),
    ]).filter((a) => !sameName(a, String(canonical.canonical_name ?? '')));
    const domainAdds = uniqueStrings(
      Array.isArray(manual.domains) ? (manual.domains as string[]) : [],
    );

    const addToSet: Document = {};
    if (aliasAdds.length) addToSet.aliases = { $each: aliasAdds };
    if (domainAdds.length) addToSet.domains = { $each: domainAdds };
    if (Object.keys(addToSet).length) {
      await this.companies.updateOne(this.scope({ company_id: canonicalId }), { $addToSet: addToSet });
    }

    const moved = await this.deals.updateMany(
      this.scope({ company_id: companyId }),
      { $set: { company_id: canonicalId } },
    );
    await this.companies.deleteOne(this.scope({ company_id: companyId }));

    return {
      outcome: 'merged',
      company_id: canonicalId,
      removed_company_id: companyId,
      registry_key: targetKey,
      deals_moved: moved.modifiedCount,
    };
  }

  private async countDonnaArtifacts(companyId: string): Promise<number> {
    const [snaps, sigs] = await Promise.all([
      this.snapshots.countDocuments(this.scope({ company_id: companyId })),
      this.signals.countDocuments(this.scope({ company_id: companyId })),
    ]);
    return snaps + sigs;
  }

  async getCompany(companyId: string): Promise<Company | null> {
    // Reads are NOT validated: Track C's own company documents omit several
    // fields our schema requires (aliases, domains, officers, resolution), so
    // validating on read would reject the live data we are here to serve.
    return (await this.companies.findOne(this.scope({ company_id: companyId }))) as
      unknown as Company | null;
  }

  async listCompanies(): Promise<Company[]> {
    return (await this.companies.find(this.scope()).toArray()) as unknown as Company[];
  }

  /** Uses our added {book_id, company_id} deals index. */
  /**
   * Deals awaiting entity resolution.
   *
   * Intake only ever writes `status: 'unresolved'` and nothing else triggers
   * resolution, so the orchestrator loop has to poll for these. `needs_review`
   * is deliberately EXCLUDED: those are waiting on a person, and re-resolving
   * them would overwrite the candidates the review list is showing.
   */
  async unresolvedDeals(limit = 50): Promise<Deal[]> {
    return (await this.deals
      .find(this.scope({ status: 'unresolved' }))
      .limit(limit)
      .maxTimeMS(10_000)
      .toArray()) as unknown as Deal[];
  }

  /**
   * Link a resolved deal to its company.
   *
   * Guarded on `status: 'unresolved'` so this can never overwrite a decision a
   * person already made, and so two loop iterations racing the same deal leave
   * exactly one winner. `resolved_by` carries the AUTO_RESOLVER sentinel, which
   * is what lets the UI distinguish an automated match from a manual one.
   *
   * Note the asymmetry with needs_review: a deal is resolved ALL THE WAY or
   * parked with nothing worth losing, because Track C's findCandidates replaces
   * the whole `resolution` subdocument the moment an analyst opens it.
   */
  async linkDealToCompany(input: {
    deal_id: string;
    company_id: string;
    confidence: number | null;
    reason: string;
    candidates_seen?: Record<string, unknown>[];
  }): Promise<boolean> {
    const now = toUtcInstant(new Date());
    const result = await this.deals.findOneAndUpdate(
      this.scope({ deal_id: input.deal_id, status: 'unresolved' }),
      {
        $set: {
          company_id: input.company_id,
          status: 'resolved',
          resolution: {
            confidence: input.confidence,
            reason: input.reason,
            resolved_by: AUTO_RESOLVER,
            resolved_at: now,
            candidates_seen: input.candidates_seen ?? [],
          },
          updated_date: now,
        },
      },
      { returnDocument: 'after' },
    );
    return result !== null;
  }

  /**
   * Park a deal for a human, with the candidates we considered attached.
   *
   * We never auto-resolve a low-confidence match: a wrong match makes every
   * later step confidently wrong, reporting another company's changes against
   * this agreement. Parking keeps NOTHING we would mind losing, because
   * findCandidates overwrites `resolution` wholesale.
   */
  async parkDealForReview(input: {
    deal_id: string;
    reason: string;
    candidates_seen?: Record<string, unknown>[];
  }): Promise<boolean> {
    const now = toUtcInstant(new Date());
    const result = await this.deals.findOneAndUpdate(
      this.scope({ deal_id: input.deal_id, status: 'unresolved' }),
      {
        $set: {
          status: 'needs_review',
          resolution: {
            confidence: null,
            reason: input.reason,
            resolved_by: AUTO_RESOLVER,
            candidates_seen: input.candidates_seen ?? [],
          },
          updated_date: now,
        },
      },
      { returnDocument: 'after' },
    );
    return result !== null;
  }

  async dealsForCompany(companyId: string): Promise<Deal[]> {
    return (await this.deals.find(this.scope({ company_id: companyId })).toArray()) as
      unknown as Deal[];
  }

  // =========================================================================
  // snapshots -- IMMUTABLE
  // =========================================================================

  /**
   * Insert a snapshot. Idempotent: re-inserting the same `snapshot_id` is a
   * no-op, so a retried collector run cannot create a duplicate or throw.
   *
   * rule 6: snapshots are immutable. There is deliberately NO updateSnapshot
   * and NO deleteSnapshot on this class. Three years of officer lists is a
   * churn pattern; one officer list is a fact; an edited history is neither.
   */
  async insertSnapshot(input: SnapshotInput): Promise<SnapshotInsertResult> {
    const doc = validate('snapshots', snapshotSchema, this.stamp({
      ...input,
      fetched_at: toUtcInstant(input.fetched_at),
      content_hash: input.content_hash ?? contentHash(input.items),
    }));
    try {
      await this.snapshots.insertOne({ ...doc });
      return { snapshot_id: doc.snapshot_id, inserted: true };
    } catch (err) {
      // The unique {book_id, snapshot_id} index is what makes this idempotent.
      if (isDuplicateKeyError(err)) return { snapshot_id: doc.snapshot_id, inserted: false };
      throw err;
    }
  }

  /**
   * THE baseline lookup: the newest successful snapshot for (company, source).
   * `ok: true` is in the filter as well as the schema -- the collection may
   * still hold documents written before the contract existed, and a failed
   * fetch used as a baseline reads as "everything was removed".
   */
  async latestOkSnapshot(companyId: string, source: Source): Promise<Snapshot | null> {
    return (await this.snapshots.findOne(
      this.scope({ company_id: companyId, source, ok: true }),
      { sort: { fetched_at: -1 } },
    )) as unknown as Snapshot | null;
  }

  async getSnapshot(snapshotId: string): Promise<Snapshot | null> {
    return (await this.snapshots.findOne(this.scope({ snapshot_id: snapshotId }))) as
      unknown as Snapshot | null;
  }

  /**
   * Resolve an evidence link to the snapshot it rests on.
   *
   * Track C's Coverage.jsx mints snapshot ids CLIENT-SIDE as
   * `snap-<company_id>-<source>` to mean "the latest one for this pair". No
   * document ever carries that id -- real snapshot ids are unique per fetch,
   * because snapshots are immutable and we keep every one. So an evidence link
   * is either an exact id or that alias, and resolving the alias is this
   * layer's job: without it, every "view the source" link in Track C 404s,
   * which is the one promise the product cannot break.
   */
  async getEvidence(snapshotIdOrAlias: string): Promise<Snapshot | null> {
    const exact = await this.getSnapshot(snapshotIdOrAlias);
    if (exact) return exact;
    const alias = parseLatestSnapshotAlias(snapshotIdOrAlias);
    if (!alias) return null;
    if (!(SOURCES as readonly string[]).includes(alias.source)) return null;
    return this.latestOkSnapshot(alias.companyId, alias.source as Source);
  }

  // =========================================================================
  // changes
  // =========================================================================

  async insertChanges(inputs: readonly ChangeInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    const docs = inputs.map((c) => validate('changes', changeSchema, this.stamp({
      ...c,
      detected_at: toUtcInstant(c.detected_at),
    })));
    const res = await this.changes.insertMany(docs.map((d) => ({ ...d })));
    return res.insertedCount;
  }

  async changesForCompany(companyId: string, sinceIso?: string): Promise<Document[]> {
    const extra: Document = { company_id: companyId };
    if (sinceIso) extra.detected_at = { $gte: toUtcInstant(sinceIso) };
    return this.changes.find(this.scope(extra)).sort({ detected_at: -1 }).toArray();
  }

  // =========================================================================
  // signals
  // =========================================================================

  /**
   * Upsert a signal by (company, type, 14-day window).
   *
   * Seeing the same kind of thing twice inside the window is CORROBORATION --
   * more evidence for one signal -- not two signals. Outside the window it is a
   * new occurrence and gets its own document (and its own signal_id, which
   * encodes the window start).
   *
   * On a merge we never weaken the signal: tier uses `$max` and confidence only
   * climbs. `first_seen` stays put -- it is "first", and Track C renders it.
   */
  async upsertSignal(input: SignalInput): Promise<SignalUpsertResult> {
    const signal = validate('signals', signalSchema, this.stamp({
      ...input,
      signal_id: input.signal_id ?? makeSignalId(input.company_id, input.type, input.first_seen),
    }));

    // Symmetric window: any existing signal of this type whose first_seen is
    // within SIGNAL_WINDOW_DAYS of this observation, in either direction
    // (evidence can arrive late). Served by donna_signals_corroboration.
    const existing = await this.signals.findOne(
      this.scope({
        company_id: signal.company_id,
        type: signal.type,
        first_seen: {
          $gte: addDays(signal.first_seen, -SIGNAL_WINDOW_DAYS),
          $lte: addDays(signal.first_seen, SIGNAL_WINDOW_DAYS),
        },
      }),
      { sort: { first_seen: -1 } },
    );

    if (!existing) {
      try {
        await this.signals.insertOne({ ...signal });
        return { signal_id: signal.signal_id, outcome: 'created' };
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        // Raced with another worker on the same signal_id; fall through to merge.
      }
    }

    const target = existing ?? await this.signals.findOne(
      this.scope({ signal_id: signal.signal_id }),
    );
    if (!target) throw new StoreError(`upsertSignal: lost signal ${signal.signal_id}.`);

    const currentConfidence = (target.confidence ?? 'low') as keyof typeof CONFIDENCE_RANK;
    const keepConfidence =
      CONFIDENCE_RANK[currentConfidence] >= CONFIDENCE_RANK[signal.confidence];

    const update: Document = {
      $addToSet: {
        evidence: { $each: signal.evidence },
        touches_terms: { $each: signal.touches_terms },
      },
      $max: { tier: signal.tier },
      $set: {
        status: signal.status,
        title: signal.title,
        summary_fact: signal.summary_fact,
        ...(keepConfidence ? {} : { confidence: signal.confidence }),
      },
    };
    await this.signals.updateOne(this.scope({ signal_id: String(target.signal_id) }), update);
    return { signal_id: String(target.signal_id), outcome: 'merged' };
  }

  async getSignal(signalIdValue: string): Promise<Signal | null> {
    return (await this.signals.findOne(this.scope({ signal_id: signalIdValue }))) as
      unknown as Signal | null;
  }

  async signalsForCompany(companyId: string): Promise<Signal[]> {
    return (await this.signals
      .find(this.scope({ company_id: companyId }))
      .sort({ tier: -1, first_seen: -1 })
      .toArray()) as unknown as Signal[];
  }

  // =========================================================================
  // clusters / briefings -- derived artifacts, so replace-in-place
  // =========================================================================

  async putCluster(input: ClusterInput): Promise<void> {
    const doc = validate('clusters', clusterSchema, this.stamp(input));
    await this.clusters.replaceOne(
      this.scope({ cluster_id: doc.cluster_id }),
      { ...doc },
      { upsert: true },
    );
  }

  async getCluster(clusterIdValue: string): Promise<Cluster | null> {
    return (await this.clusters.findOne(this.scope({ cluster_id: clusterIdValue }))) as
      unknown as Cluster | null;
  }

  async putBriefing(input: BriefingInput): Promise<void> {
    const doc = validate('briefings', briefingSchema, this.stamp({
      ...input,
      generated_at: toUtcInstant(input.generated_at),
    }));
    await this.briefings.replaceOne(
      this.scope({ briefing_id: doc.briefing_id }),
      { ...doc },
      { upsert: true },
    );
  }

  async getBriefing(briefingIdValue: string): Promise<Briefing | null> {
    return (await this.briefings.findOne(this.scope({ briefing_id: briefingIdValue }))) as
      unknown as Briefing | null;
  }

  async latestBriefing(companyId: string, mode: 'briefing' | 'profile'): Promise<Briefing | null> {
    return (await this.briefings.findOne(
      this.scope({ company_id: companyId, mode }),
      { sort: { generated_at: -1 } },
    )) as unknown as Briefing | null;
  }

  // =========================================================================
  // collector_runs
  // =========================================================================

  async startRun(input: RunStartInput): Promise<RunHandle> {
    const doc = validate('collector_runs', collectorRunSchema, this.stamp({
      run_id: input.run_id,
      batch_id: input.batch_id,
      company_id: input.company_id,
      source: input.source,
      started_at: toUtcInstant(input.started_at ?? isoNow()),
      ended_at: null,
      status: 'started' as const,
      error: null,
      credits_spent: 0,
      sandbox_id: input.sandbox_id ?? null,
      cache_hit: input.cache_hit ?? false,
    }));
    const res = await this.runs.insertOne({ ...doc });
    return { _id: res.insertedId, run_id: doc.run_id };
  }

  /**
   * Close out a run. Pass the handle startRun returned; a bare `run_id` is
   * accepted but resolves to the NEWEST still-`started` run with that id,
   * because run_id repeats across scheduled runs.
   */
  async finishRun(ref: RunHandle | string, patch: RunFinishPatch): Promise<void> {
    const filter = typeof ref === 'string'
      ? this.scope({ run_id: ref, status: 'started' })
      : this.scope({ _id: ref._id });
    const sort = typeof ref === 'string' ? { started_at: -1 as const } : undefined;

    const current = await this.runs.findOne(filter, sort ? { sort } : {});
    if (!current) {
      throw new StoreError(
        `finishRun: no ${typeof ref === 'string' ? 'started ' : ''}run matching `
        + `${JSON.stringify(typeof ref === 'string' ? ref : ref._id.toHexString())}.`,
      );
    }

    const set = {
      status: patch.status,
      error: patch.error ?? null,
      credits_spent: patch.credits_spent ?? (current.credits_spent as number | undefined) ?? 0,
      ended_at: toUtcInstant(patch.ended_at ?? isoNow()),
      cache_hit: patch.cache_hit ?? Boolean(current.cache_hit),
      sandbox_id: patch.sandbox_id ?? ((current.sandbox_id ?? null) as string | null),
    };
    // Validate the document we are about to PRODUCE, not just the patch, so a
    // partial update cannot leave an invalid run row behind. (zod strips the
    // extra _id for us.)
    validate('collector_runs', collectorRunSchema, { ...current, ...set });
    await this.runs.updateOne({ _id: current._id }, { $set: set });
  }

  async getRun(ref: RunHandle | string): Promise<CollectorRun | null> {
    const doc = typeof ref === 'string'
      ? await this.runs.findOne(this.scope({ run_id: ref }), { sort: { started_at: -1 } })
      : await this.runs.findOne(this.scope({ _id: ref._id }));
    return doc as unknown as CollectorRun | null;
  }

  /**
   * The coverage-matrix cell: the newest run for a (company, source).
   * Track C's Coverage.jsx links to `run-<company_id>-<source>`, which is an
   * alias for exactly this, so resolve it here rather than letting the link
   * 404. Served by donna_runs_latest.
   */
  async latestRun(companyId: string, source: Source): Promise<CollectorRun | null> {
    return (await this.runs.findOne(
      this.scope({ company_id: companyId, source }),
      { sort: { started_at: -1 } },
    )) as unknown as CollectorRun | null;
  }

  async runsForBatch(batchIdValue: string): Promise<CollectorRun[]> {
    return (await this.runs.find(this.scope({ batch_id: batchIdValue })).toArray()) as
      unknown as CollectorRun[];
  }

  /**
   * A run still `started` after `olderThanMinutes` is dead (the process that
   * owned it crashed, was redeployed, or hit a sandbox timeout). Mark it
   * `failed` and push its schedule to the next slot, so a restart recovers by
   * itself instead of waiting for a human to notice a stuck company.
   */
  async reapStaleRuns(olderThanMinutes: number = STALE_RUN_MINUTES): Promise<ReapResult> {
    const cutoff = toUtcInstant(new Date(Date.now() - olderThanMinutes * 60_000));
    const stale = await this.runs
      .find(this.scope({ status: 'started', started_at: { $lt: cutoff } }))
      .toArray();

    let pushed = 0;
    const runIds: string[] = [];
    for (const run of stale) {
      await this.runs.updateOne({ _id: run._id }, {
        $set: {
          status: 'failed',
          error: `stale run reaped: still 'started' after ${olderThanMinutes} minutes`,
          ended_at: isoNow(),
        },
      });
      runIds.push(String(run.run_id));
      if (await this.pushSchedule(String(run.company_id), run.source as Source)) pushed += 1;
    }
    return { reaped: stale.length, run_ids: runIds, schedules_pushed: pushed };
  }

  /**
   * Turn off every enabled schedule whose bounded watch has ended. dueSchedules
   * already refuses to return them; this makes an ended watch stop being a
   * candidate at all, instead of being filtered out on every tick forever. The
   * loop calls it from its reap step. Returns how many were disabled.
   */
  async disableExpiredSchedules(now: string | Date = new Date()): Promise<number> {
    const res = await this.schedules.updateMany(
      this.scope({ enabled: true, expires_at: { $ne: null, $lte: toUtcInstant(now) } }),
      { $set: { enabled: false } },
    );
    return res.modifiedCount;
  }

  async creditsSpentTotal(): Promise<number> {
    const [row] = await this.runs.aggregate<{ total: number }>([
      { $match: this.scope() },
      { $group: { _id: null, total: { $sum: '$credits_spent' } } },
    ]).toArray();
    return row?.total ?? 0;
  }

  // =========================================================================
  // schedules
  // =========================================================================

  /**
   * Companies in this book that have no schedules at all.
   *
   * Collection only ever started as a side effect of automated resolution, so a
   * company added by hand -- Track C's "add company" path, or a deal created
   * with an existing company already picked -- landed in the book with no
   * schedules and was never collected. It looked monitored and was inert, which
   * is the quiet kind of wrong this product is supposed to refuse: the page
   * showed no checks, truthfully, while the book implied it was being watched.
   *
   * The loop uses this to CONVERGE on the invariant "every company has
   * schedules", rather than trusting one code path to have created them.
   */
  async companiesWithoutSchedules(limit = 50): Promise<Company[]> {
    const scheduled = new Set(
      await this.schedules.distinct('company_id', this.scope({})),
    );
    // A prospect -- `lookup` set, no `monitoring_since` -- has no schedules ON
    // PURPOSE: a lookup is one shot. Backfilling it would hand every company
    // somebody glanced at the normal daily cadence, forever.
    const all = await this.companies
      .find(this.scope({ $or: [{ lookup: { $exists: false } }, { monitoring_since: { $exists: true } }] }))
      .limit(limit + scheduled.size)
      .maxTimeMS(10_000)
      .toArray();
    return (all as unknown as Company[])
      .filter((c) => !scheduled.has(c.company_id))
      .slice(0, limit);
  }

  async upsertSchedule(input: ScheduleInput): Promise<void> {
    const doc = validate('schedules', scheduleSchema, this.stamp({
      company_id: input.company_id,
      source: input.source,
      cadence: input.cadence,
      next_run_at: toUtcInstant(input.next_run_at),
      last_run_at: input.last_run_at ? toUtcInstant(input.last_run_at) : null,
      enabled: input.enabled ?? true,
      expires_at: input.expires_at ? toUtcInstant(input.expires_at) : null,
    }));
    await this.schedules.replaceOne(
      this.scope({ company_id: doc.company_id, source: doc.source }),
      { ...doc },
      { upsert: true },
    );
  }

  /** The orchestrator loop IS the scheduler: it polls this. */
  async dueSchedules(now: string | Date = new Date()): Promise<Schedule[]> {
    const at = toUtcInstant(now);
    // An expired watch is never due, even before the reaper has disabled it.
    // `expires_at: null` also matches a document written before the field
    // existed, so old schedules need no special case.
    return (await this.schedules
      .find(this.scope({
        enabled: true,
        next_run_at: { $lte: at },
        $or: [{ expires_at: null }, { expires_at: { $gt: at } }],
      }))
      .sort({ next_run_at: 1 })
      .toArray()) as unknown as Schedule[];
  }

  async schedulesForCompany(companyId: string): Promise<Schedule[]> {
    return (await this.schedules.find(this.scope({ company_id: companyId })).toArray()) as
      unknown as Schedule[];
  }

  // =========================================================================
  // pre-deal lookups
  //
  // A lookup is a `companies` document with `lookup` set and no
  // `monitoring_since` -- no collection of its own. The surface writes the
  // intent; the loop polls for it here.
  // =========================================================================

  /**
   * Lookup intents not yet collected: `lookup` set, no `last_checked_at`.
   * Oldest request first.
   *
   * An intent the resolver already parked (still a manual key, but resolved
   * by the auto-resolver) is excluded, so a company we could not
   * identify waits for a person instead of being re-resolved -- and re-billed
   * -- on every tick.
   */
  async lookupIntents(limit = 1): Promise<Company[]> {
    return (await this.companies
      .find(this.scope({
        lookup: { $exists: true },
        last_checked_at: { $exists: false },
        $nor: [{
          registry_key: { $regex: `^${MANUAL_REGISTRY_PREFIX}` },
          'resolution.resolved_by': AUTO_RESOLVER,
        }],
      }))
      .sort({ 'lookup.requested_at': 1 })
      .limit(limit)
      .toArray()) as unknown as Company[];
  }

  /**
   * Set monitoring_since if it is not set already. A company promoted twice
   * keeps the day it was first monitored. Returns the value now on the record.
   */
  async setMonitoringSince(companyId: string, day: string): Promise<string> {
    await this.companies.updateOne(
      this.scope({ company_id: companyId, monitoring_since: { $exists: false } }),
      { $set: { monitoring_since: day } },
    );
    const doc = await this.companies.findOne(this.scope({ company_id: companyId }));
    if (!doc) {
      throw new StoreError(`setMonitoringSince: no company ${JSON.stringify(companyId)} in book ${this.bookId}.`);
    }
    return String(doc.monitoring_since);
  }

  /**
   * Credits spent collecting prospects -- companies with `lookup` and no
   * `monitoring_since`. This is what the lookup ceiling is measured against,
   * separately from creditsSpentTotal. Once a prospect is promoted its runs
   * count as monitoring: they are still in the total, just not in this quota.
   */
  async creditsSpentOnLookups(): Promise<number> {
    const ids = await this.companies.distinct(
      'company_id',
      this.scope({ lookup: { $exists: true }, monitoring_since: { $exists: false } }),
    );
    if (ids.length === 0) return 0;
    const [row] = await this.runs.aggregate<{ total: number }>([
      { $match: this.scope({ company_id: { $in: ids } }) },
      { $group: { _id: null, total: { $sum: '$credits_spent' } } },
    ]).toArray();
    return row?.total ?? 0;
  }

  async getSchedule(companyId: string, source: Source): Promise<Schedule | null> {
    return (await this.schedules.findOne(this.scope({ company_id: companyId, source }))) as
      unknown as Schedule | null;
  }

  /**
   * Move a schedule to its next slot from now. Returns false when there is no
   * schedule for that pair (a one-off collection, which needs no push).
   */
  async pushSchedule(companyId: string, source: Source, from: Date = new Date()): Promise<boolean> {
    const schedule = await this.schedules.findOne(this.scope({ company_id: companyId, source }));
    if (!schedule) return false;
    const hours = schedule.cadence === 'weekly' ? 24 * 7 : 24;
    await this.schedules.updateOne(
      this.scope({ company_id: companyId, source }),
      {
        $set: {
          next_run_at: toUtcInstant(new Date(from.getTime() + hours * 3_600_000)),
          last_run_at: toUtcInstant(from),
        },
      },
    );
    return true;
  }

  // =========================================================================
  // fetch_cache
  // =========================================================================

  async getCached<T = unknown>(url: string, day: string = toUtcDay()): Promise<T | null> {
    const doc = await this.fetchCache.findOne(this.scope({ cache_key: fetchCacheKey(url, day) }));
    if (!doc) return null;
    // Mongo's TTL monitor runs about once a minute, so an expired document can
    // still be present. Honour expires_at on read rather than serving stale data.
    const expires = doc.expires_at instanceof Date ? doc.expires_at : null;
    if (expires && expires.getTime() <= Date.now()) return null;
    return doc.payload as T;
  }

  async putCached(url: string, payload: unknown, opts: PutCachedOptions = {}): Promise<void> {
    const day = opts.day ?? toUtcDay();
    const ttlHours = opts.ttlHours ?? FETCH_CACHE_TTL_HOURS;
    const doc = validate('fetch_cache', fetchCacheEntrySchema, this.stamp({
      cache_key: fetchCacheKey(url, day),
      url,
      utc_day: day,
      payload,
      credits_spent: opts.credits_spent ?? 0,
      created_at: isoNow(),
      expires_at: new Date(Date.now() + ttlHours * 3_600_000),
    }));
    await this.fetchCache.replaceOne(
      this.scope({ cache_key: doc.cache_key }),
      { ...doc },
      { upsert: true },
    );
  }
}

/**
 * rule 1, the structural half. A store without a usable book id must not exist,
 * because every document it would write is invisible to Track C and every
 * document it would read belongs to someone else.
 */
function assertBookId(bookId: unknown): asserts bookId is string {
  if (typeof bookId !== 'string' || bookId.trim().length === 0) {
    throw new StoreError(
      'DonnaStore requires a non-empty bookId (a Base44 user id). Every document '
      + 'is scoped by book_id; without one, writes are invisible to Track C and '
      + 'reads cross tenants.',
    );
  }
}
