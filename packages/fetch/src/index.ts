/**
 * @donna/fetch -- Bright Data is the sole fetch path for the whole system.
 *
 * Nothing outside this package may call bare `fetch()` against a target site.
 * Everything here works offline: with DONNA_FETCH_MODE unset the client runs
 * in `replay` mode off committed cassettes, so no credential and no network
 * are needed to build or test the rest of Donna.
 */

export {
  DEFAULT_FETCH_MODE,
  cassetteSchema,
  fetchModeSchema,
  type BrightDataClient,
  type Cassette,
  type CassetteStore,
  type FetchLike,
  type FetchMode,
  type FetchResult,
  type HttpRequestInit,
  type HttpResponse,
  type SerpEngine,
  type SerpOptions,
  type SerpPage,
  type SerpPayloadKind,
  type SerpResult,
} from './types.js';

export {
  CassetteMissError,
  CreditCeilingError,
  FetchError,
  isFetchError,
  type FetchErrorCode,
} from './errors.js';

export {
  BRIGHTDATA_ENDPOINT,
  CREDITS_PER_REQUEST,
  DEFAULT_TIMEOUT_MS,
  readCreditCeiling,
  readTimeoutMs,
  resolveFetchMode,
  type Env,
} from './config.js';

export {
  FileCassetteStore,
  MemoryCassetteStore,
  cassetteFileName,
  defaultCassetteDir,
} from './cassette.js';

export {
  DEFAULT_GL,
  DEFAULT_HL,
  parseSerpHtml,
  parseSerpJson,
  parseSerpResults,
  serpJsonSchema,
  serpOrganicSchema,
  serpPayloadKind,
  serpUrl,
  type SerpJson,
} from './serp.js';

export {
  BrightDataFetcher,
  createBrightDataClient,
  type BrightDataClientOptions,
} from './client.js';

export {
  forbiddenFetch,
  stubFetch,
  type StubCall,
  type StubFetch,
  type StubReply,
} from './testing.js';
