export { mainDbConfig, txTimeouts, type TxTimeouts } from './config.ts';
export { MAIN_MIGRATIONS_DIR, migrateMain } from './migrate.ts';
export {
  createMainDb,
  createPool,
  ping,
  type MainDbHandle,
  type Pool,
  type PoolErrorHandler,
} from './pool.ts';
export {
  CREDENTIAL_KINDS,
  CredentialRepository,
  type CredentialKind,
  type CredentialRef,
  type CredentialRepositoryOptions,
  type CredentialSlot,
} from './credentials.ts';
export type {
  AuditActorKind,
  ChannelProvider,
  MainDb,
  MembershipRole,
  VatPeriod,
} from './schema.ts';
export { JobRecordRepository, type JobProgress } from './job-records.ts';
export { createQueues } from './queue-schema.ts';
export { Tenancy, withTenantTransaction } from './tenant.ts';
export { JobLeaseRepository } from './job-leases.ts';
export { FileRepository } from './files.ts';
export { ChannelAccountCompanyLocked, LastAdmin, WorkspaceLimitReached } from './errors.ts';
export {
  setWorkspaceModule,
  WorkspaceRepository,
  type NewWorkspace,
  type Workspace,
  type WorkspaceModule,
} from './workspaces.ts';
export {
  CompanyRepository,
  type Company,
  type CompanyAddress,
  type NewCompany,
} from './companies.ts';
export {
  ChannelAccountRepository,
  type ChannelAccount,
  type NewChannelAccount,
} from './channel-accounts.ts';
export { MembershipRepository, UserRepository, type User } from './users.ts';
export { DeletionLog, type DeletionCertificate, type DeletionRun } from './deletion.ts';
export { erasureDueAt, ErasureRequestRepository, type ErasureRequest } from './erasure.ts';
export {
  isNotificationCursor,
  NotificationRepository,
  type EmailJobView,
  type Notification,
  type NotificationCursor,
  type NotificationFilter,
  type NotificationViewer,
  type PlatformEmail,
} from './notifications.ts';
export {
  ACCESS_REVIEW_INTERVAL_MS,
  AccessReviewRepository,
  INVITE_LIFETIME_MS,
  InviteRepository,
  MemberAccessRepository,
  type Access,
  type AccessReview,
  type Invite,
  type Member,
} from './permissions.ts';
export { rewrapAllDataKeys, type DataKeyTotals } from './rewrap.ts';
export {
  AuditLog,
  AuditReasonRequired,
  isAuditCursor,
  type AuditActor,
  type AuditCursor,
  type AuditEvent,
  type AuditFilter,
  type NewAuditEvent,
} from './audit.ts';
export {
  AuthStore,
  issuePasswordReset,
  RESET_LINK_MS,
  type AuthUser,
  type FailureResult,
  type LockNotice,
  type ResetVerdict,
  type LoginAccount,
  type MfaState,
  type PlatformKeyRow,
  type SessionStage,
  type StoredSession,
  type WorkspaceChoiceRow,
} from './auth.ts';
