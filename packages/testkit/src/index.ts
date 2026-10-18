/**
 * Fixtures, synthetic data with PII markers, and the route walker (later tasks).
 *
 * T-0101 adds the PostgreSQL helper that integration tests use.
 */
export const PACKAGE_NAME = '@omnibridge/testkit';

/** Prefix for every PII-like synthetic value, so the marker scan can find leaks (invariant 7). */
export const PII_MARKER = 'PIIMARK-';

export { POSTGRES_IMAGE, startRoleCluster, type RoleCluster } from './postgres.ts';
