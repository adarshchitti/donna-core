/**
 * Cassette stores: the file-backed fetch cache used offline, plus an in-memory
 * one for tests. Both implement `CassetteStore`, so the Mongo-backed
 * `fetch_cache` can be dropped in later without touching the client.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cassetteSchema, type Cassette, type CassetteStore } from './types.js';

/**
 * Filename for a cache key.
 *
 * sha256 hex, because the key embeds a full URL: `/`, `?`, `&`, `:` and `%` are
 * either illegal or ambiguous in a filename, and real target URLs blow past
 * the 255-byte limit. The original URL is kept inside the JSON instead.
 */
export const cassetteFileName = (key: string): string =>
  `${createHash('sha256').update(key).digest('hex')}.json`;

/** Repo-root `fixtures/cassettes`, resolved from this file so cwd never matters. */
export const defaultCassetteDir = (): string =>
  resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../fixtures/cassettes');

export class FileCassetteStore implements CassetteStore {
  readonly dir: string;

  constructor(dir: string = defaultCassetteDir()) {
    this.dir = dir;
  }

  locate(key: string): string {
    return join(this.dir, cassetteFileName(key));
  }

  async get(key: string): Promise<Cassette | undefined> {
    const path = this.locate(key);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      // A miss and an unreadable file are the same thing to a caller: no
      // cassette. The client turns it into a CassetteMissError naming the path.
      return undefined;
    }
    const parsed = cassetteSchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success) {
      throw new Error(
        `Corrupt cassette at ${path}: ` +
          parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(', '),
      );
    }
    return parsed.data;
  }

  async put(cassette: Cassette): Promise<void> {
    const path = this.locate(cassette.key);
    await mkdir(dirname(path), { recursive: true });
    // Pretty-printed: these are committed fixtures a human reviews in a diff.
    await writeFile(path, `${JSON.stringify(cassetteSchema.parse(cassette), null, 2)}\n`, 'utf8');
  }
}

/** Non-persistent store, for tests that do not care about disk. */
export class MemoryCassetteStore implements CassetteStore {
  private readonly byKey = new Map<string, Cassette>();

  locate(key: string): string {
    return `memory://cassettes/${cassetteFileName(key)}`;
  }

  async get(key: string): Promise<Cassette | undefined> {
    return this.byKey.get(key);
  }

  async put(cassette: Cassette): Promise<void> {
    this.byKey.set(cassette.key, cassetteSchema.parse(cassette));
  }

  get size(): number {
    return this.byKey.size;
  }
}
