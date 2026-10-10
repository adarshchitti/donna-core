/**
 * The narrator: one Claude call per cluster, and the post-processor that makes
 * its output publishable.
 *
 * The two are one module on purpose. Split them and the prompt and the gate end
 * up disagreeing about what counts as a citation -- which is precisely the
 * failure this feature exists to prevent. `postprocess.ts` is the primary
 * deliverable; `prompt.ts` is how we usually avoid needing it.
 */
export * from './model.js';
export * from './types.js';
export * from './forbidden.js';
export * from './sentences.js';
export * from './prompt.js';
export * from './postprocess.js';
export * from './fallback.js';
export * from './narrate.js';
