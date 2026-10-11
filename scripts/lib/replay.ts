/**
 * The replay fetch path, shared by measure-credits and onboard-book's dry run.
 *
 * Same map the collectors CLI builds (donna-collectors/src/cli.ts): each URL a
 * collector will request, bound to the saved fixture that answers it. The
 * fixtures are captures for specific companies -- Big Lots for the unlocker
 * sources, Battelle for news/jobs, Bath & Body Works for executives -- so a
 * replayed run exercises the full code path but the ITEMS describe the
 * recorded company, not the one being replayed. Replay is for exercising the
 * pipeline and counting fetches, never for what a source says about a company.
 */
import { resolve } from 'node:path';
import { COLLECTORS_REPO } from './env.js';
import { ReplayFetcher, serpKey, unlockerKey, type ReplayMap } from '../../../donna-collectors/src/fetcher/replay.js';
import type { CanonicalCompany, Fetcher, Source } from '../../../donna-collectors/src/contract.js';
import { searchUrl as registrySearchUrl, companyUrl as registryCompanyUrl } from '../../../donna-collectors/src/collectors/registry.js';
import { searchUrl as courtSearchUrl } from '../../../donna-collectors/src/collectors/court.js';
import { newsQuery } from '../../../donna-collectors/src/collectors/news.js';
import { execQuery } from '../../../donna-collectors/src/collectors/executives.js';
import { jobsQuery } from '../../../donna-collectors/src/collectors/jobs.js';
import { whoisUrl, homeUrl } from '../../../donna-collectors/src/collectors/domain.js';

export const FIXTURES_DIR = resolve(COLLECTORS_REPO, 'fixtures');

export const replayMap = (company: CanonicalCompany, source: Source): ReplayMap => {
  switch (source) {
    case 'registry':
      return {
        [unlockerKey(registrySearchUrl(company))]: 'registry/opencorporates-search-biglots.html',
        // the company page the collector picks out of the captured search
        [unlockerKey(registryCompanyUrl('1215332'))]: 'registry/opencorporates-company-biglots.html',
      };
    case 'court':
      return { [unlockerKey(courtSearchUrl(company))]: 'court/courtlistener-search-biglots.json' };
    case 'regulator':
    case 'layoffs':
      // both collectors fail visibly before any fetch (government domains)
      return {};
    case 'domain': {
      const d = company.domains[0];
      return d
        ? {
            [unlockerKey(whoisUrl(d))]: 'domain/whois-healthy.html',
            [unlockerKey(homeUrl(d))]: 'domain/home-healthy.html',
          }
        : {};
    }
    case 'news':
      return {
        [serpKey(newsQuery(company))]: 'news/serp-healthy.json',
        [unlockerKey('https://www.battelle.org/insights/newsroom')]: 'news/article-newsroom.html',
        [unlockerKey('https://www.battelle.org/')]: 'news/article-homepage.html',
        [unlockerKey('https://inside.battelle.org/')]: 'news/article-blog.html',
      };
    case 'executives':
      return {
        [serpKey(execQuery(company))]: 'executives/serp-healthy.json',
        [unlockerKey('https://investors.bbwinc.com/news-releases/news-release-details/bath-body-works-appoints-daniel-heaf-chief-executive-officer')]:
          'executives/pr-healthy.html',
      };
    case 'jobs':
      return {
        [serpKey(jobsQuery(company))]: 'jobs/serp-healthy.json',
        [unlockerKey('https://www.battelle.org/careers')]: 'jobs/careers-healthy.html',
      };
  }
};

export const replayFetcher = (company: CanonicalCompany, source: Source): Fetcher =>
  new ReplayFetcher(replayMap(company, source), FIXTURES_DIR);
