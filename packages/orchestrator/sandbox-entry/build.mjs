import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const collectorsRepo = process.env.DONNA_COLLECTORS_REPO
  ?? resolve(here, '../../../../donna-collectors');

/**
 * Bundle the entry point AND the collector repo into one file with no runtime
 * dependencies, so a bare sandbox needs nothing installed. The collectors are
 * a separate repo on purpose; this is the only place the two are joined, and it
 * happens at build time rather than by shipping a node_modules tree.
 */
await build({
  entryPoints: [resolve(here, 'entry.ts')],
  outfile: resolve(here, 'dist/collector-job.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minify: false,          // a readable bundle is debuggable on stage
  sourcemap: false,
  alias: { 'donna-collectors': resolve(collectorsRepo, 'src/index.ts') },
  logLevel: 'info',
});
