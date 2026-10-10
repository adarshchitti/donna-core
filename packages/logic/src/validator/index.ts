/**
 * The validator: Change[] in, zero or one Cluster plus its Signal[] out.
 *
 * Steps, in order: classify and tier (classify.ts) -> confidence from source
 * trust (trust.ts) -> corroborate (corroborate.ts) -> exposure join
 * (exposure.ts) -> cluster and promote (cluster.ts). Baseline mode lives in
 * baseline.ts, watch terms in watchTerms.ts, and every tier and threshold in
 * rules.json.
 */
export * from './rules.js';
export * from './dates.js';
export * from './classify.js';
export * from './trust.js';
export * from './watchTerms.js';
export * from './corroborate.js';
export * from './exposure.js';
export * from './cluster.js';
export * from './baseline.js';
export * from './validate.js';
