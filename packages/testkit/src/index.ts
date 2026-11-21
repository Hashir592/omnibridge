/**
 * Fixtures, synthetic data with PII markers, and the route walker (later tasks).
 *
 * T-0101 adds the PostgreSQL helper that integration tests use; T-0102 the route walker stub;
 * T-0201 the isolation walk and the stub auth used until T-0203.
 */
export const PACKAGE_NAME = '@omnibridge/testkit';

export {
  PII_MARKER,
  TOKEN_MARKER,
  scanDatabaseForMarkers,
  scanTextForMarkers,
  type MarkerHit,
} from './marker-scan.ts';

export { POSTGRES_IMAGE, startRoleCluster, type RoleCluster } from './postgres.ts';
export {
  walkIsolation,
  walkPlatform,
  walkRoutes,
  type InjectRequest,
  type IsolationWalk,
  type PlatformOutcome,
  type PlatformWalk,
  type WalkCall,
  type WalkedRoute,
  type WalkOutcome,
} from './route-walker.ts';
export {
  platformHeaders,
  sessionHeaders,
  stubAuth,
  TEST_PLATFORM_HEADER,
  TEST_SESSION_HEADER,
  type StubAuth,
} from './auth-stub.ts';
