/**
 * The Ask surface: a question over stored records, answered by a model that
 * may choose and phrase but is never the source of a fact.
 *
 * Three parts, mirroring the narrator's architecture:
 *   retrieve.ts    -- deterministic retrieval. The model never searches; the
 *                     candidate set IS the world it can cite.
 *   deterministic  -- the code-built answer. Runs when there is no client and
 *                     is the floor the model path falls back to.
 *   postprocess.ts -- the gate. Same mechanism as the narrator's: resolve
 *                     inline citations, strip uncited facts, reject forbidden
 *                     language outright.
 */
export * from './types.js';
export * from './model.js';
export * from './retrieve.js';
export * from './deterministic.js';
export * from './postprocess.js';
export * from './prompt.js';
export * from './answer.js';
