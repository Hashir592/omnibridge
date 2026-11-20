import { describe, expect, it } from 'vitest';
import { listMyWorkspaces, WorkspaceListSchema } from './routes/auth.ts';

describe('workspace picker answer', () => {
  it('[PLAT-1] GET /auth/workspaces answers the workspaces and a platform_admin flag (PS-034)', () => {
    expect(listMyWorkspaces.responses[200]).toBe(WorkspaceListSchema);
    const ok = WorkspaceListSchema.safeParse({ workspaces: [], platform_admin: true });
    expect(ok.success).toBe(true);
    // The flag is required, so the picker never has to guess.
    expect(WorkspaceListSchema.safeParse({ workspaces: [] }).success).toBe(false);
  });
});
