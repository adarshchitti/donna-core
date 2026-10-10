/**
 * Value normalisation shared by the per-source rule table.
 *
 * These live apart from the table because they are the only place in the
 * differ where we are allowed to alter what a collector observed, and that
 * deserves to be visible in one short file rather than buried in a branch.
 */
import type { Item } from '@donna/contracts';

/**
 * Read one field off an Item as a comparable string.
 *
 * Items are `passthrough` by contract, so every field beyond `key`/`type` is
 * `unknown`. Flattening to a string is what lets identity and state be
 * compared by equality rather than by a deep-equal walk per field: a number
 * 28 and the string "28" are the same observation as far as a registry page
 * is concerned, and the differ reports change, not type drift.
 *
 * Missing and null collapse to '' deliberately -- a field a source stopped
 * publishing is not the same event as a field whose value moved, and the
 * source table decides which fields matter at all.
 */
export const fieldValue = (item: Item, field: string): string => {
  const value = item[field];
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
};

/**
 * Normalise a headline so one wire story under twelve outlet URLs is one item.
 *
 * Lowercase, punctuation and symbols to spaces, whitespace collapsed. Spaces
 * rather than nothing, so "co-founder" and "co founder" agree while
 * "de-brief" does not silently become "debrief".
 */
export const normaliseHeadline = (headline: string): string =>
  headline
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The news dedupe key for one article.
 *
 * `headline_norm` is a contract field collectors are expected to carry, but we
 * re-normalise it anyway: normalisation is idempotent, and a collector that
 * forgot to lowercase would otherwise reintroduce the twelve-copy problem that
 * this key exists to kill. Falling back to the URL keeps untitled items
 * distinct instead of collapsing them all onto one phantom story.
 */
export const storyKey = (item: Item): string => {
  const given = fieldValue(item, 'headline_norm') || fieldValue(item, 'headline');
  if (given !== '') return normaliseHeadline(given);
  return `url\u0000${fieldValue(item, 'url') || item.key}`;
};
