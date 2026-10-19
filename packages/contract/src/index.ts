/**
 * The shared API contract: one Zod route registry drives server validation, the committed
 * openapi.json and the typed client (`@omnibridge/contract/client`). See ADR-004.
 */
export const PACKAGE_NAME = '@omnibridge/contract';

export {
  ADMIN_ONLY_TABS,
  AUTH_KINDS,
  TABS,
  TICKABLE_TABS,
  type AuthKind,
  type RouteMetadata,
  type Tab,
} from './metadata.ts';
export { listQuery, pageOf, PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from './pagination.ts';
export { PROBLEM_CONTENT_TYPE, ProblemSchema, type Problem } from './problem.ts';
export { contractRoutes, OPENAPI_INFO, type ContractRoutes } from './registry.ts';
export { getJob, JobProgressSchema, type JobProgress } from './routes/jobs.ts';
export { getFile } from './routes/files.ts';
export { FileDownloadSchema, type FileDownload } from './download.ts';
export {
  assertRouteMetadata,
  ContractError,
  defineRoute,
  HTTP_METHODS,
  routeMetadataProblems,
  type AnyRoute,
  type HttpMethod,
  type RouteDefinition,
  type RouteInput,
  type RouteResult,
} from './route.ts';
export { getHealth, HealthSchema, type Health } from './routes/health.ts';
