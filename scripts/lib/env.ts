/**
 * Environment loading for the ops scripts.
 *
 * `.env.local` is parsed by hand rather than `source`d: MONGODB_URI contains an
 * unquoted `&`, which is a syntax error to zsh but just a character here.
 * Values are never printed -- the file exists precisely so they stay out of
 * the transcript. Shell-provided variables win over the file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const COLLECTORS_REPO = resolve(REPO_ROOT, '../donna-collectors');
export const DEFAULT_ENV_PATH = resolve(REPO_ROOT, '.env.local');

const LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export const loadEnv = (
  path: string = DEFAULT_ENV_PATH,
  env: Record<string, string | undefined> = process.env,
): void => {
  if (!existsSync(path)) return; // the shell may have provided everything
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = LINE.exec(trimmed);
    if (!m || !m[1]) continue;
    let value = m[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[m[1]] === undefined) env[m[1]] = value;
  }
};

export class UsageError extends Error {}

/**
 * Read a variable or die trying. A missing credential must stop the script
 * BEFORE anything is written or spent: a wrong book id is invisible data, and
 * a missing key discovered mid-run is half a batch.
 */
export const requireEnv = (
  env: Record<string, string | undefined>,
  name: string,
  why: string,
): string => {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new UsageError(`${name} is not set -- ${why}. Check .env.local or the shell environment.`);
  }
  return value.trim();
};

export const flagValue = (
  argv: readonly string[],
  flag: string,
): string | undefined => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
