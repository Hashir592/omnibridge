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
export {
  pagedOf,
  pageOffset,
  pageQuery,
  pageResult,
  PAGE_LIMITS,
  PAGE_MAX,
  TOTAL_COUNT_CAP,
  type PageQuery,
} from './pages.ts';
export { PROBLEM_CONTENT_TYPE, ProblemSchema, type Problem } from './problem.ts';
export { contractRoutes, OPENAPI_INFO, type ContractRoutes } from './registry.ts';
export { getJob, JobProgressSchema, type JobProgress } from './routes/jobs.ts';
export { getFile } from './routes/files.ts';
export {
  AddressSchema,
  CompanySchema,
  createCompany,
  createWorkspace,
  listCompanies,
  NewCompanySchema,
  type Company,
} from './routes/tenancy.ts';
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
export * from './routes/users.ts';
export {
  EBAY_ACCOUNT_DELETION_PATH,
  ebayAccountDeletion,
  ebayAccountDeletionChallenge,
  webhookRoutes,
} from './routes/webhooks.ts';
export {
  AuditEventSchema,
  auditFilters,
  exportAuditEvents,
  listAuditEvents,
  type AuditEvent,
  type AuditFilters,
} from './routes/audit.ts';
export {
  authRoutes,
  MfaConfirmResultSchema,
  MfaEnrolmentSchema,
  MfaResultSchema,
  ResetTokenInfoSchema,
  SignInResultSchema,
  WorkspaceChoiceSchema,
} from './routes/auth.ts';
