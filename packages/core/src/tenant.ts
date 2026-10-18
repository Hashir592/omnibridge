/**
 * Who a repository call acts for (invariant 3). Every repository function takes one, inside a
 * transaction that has run `SET LOCAL app.workspace_id`. T-0201 adds the company set and the
 * request and job wrappers that open that transaction.
 */
export interface TenantContext {
  readonly workspaceId: string;
}
