import type { z } from 'zod';

/**
 * Thrown when a document fails its contract schema. It is thrown BEFORE the
 * write reaches Mongo, which is the whole point: Track C renders whatever it
 * finds, so a malformed document that lands in the database is not an error
 * anywhere -- it is a blank screen three layers away from the cause.
 */
export class StoreValidationError extends Error {
  readonly issues: readonly { path: string; message: string }[];

  constructor(what: string, error: z.ZodError) {
    const issues = error.issues.map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
    }));
    super(
      `${what} failed contract validation:\n` +
        issues.map((i) => `  ${i.path}: ${i.message}`).join('\n'),
    );
    this.name = 'StoreValidationError';
    this.issues = issues;
  }
}

/** Parse-or-throw with a message that names the offending field paths. */
export function validate<S extends z.ZodTypeAny>(
  what: string,
  schema: S,
  doc: unknown,
): z.output<S> {
  const result = schema.safeParse(doc);
  if (!result.success) throw new StoreValidationError(what, result.error);
  return result.data;
}

/** Thrown for structural misuse of the store (bad book id, illegal merge, ...). */
export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}
