import { describe, expect, it } from 'vitest';
import { WorkspaceChoiceSchema } from './routes/auth.ts';
import { acceptInvite } from './routes/users.ts';

// T-0211, PS-024 (ADR-059, ADR-061): module toggles reach the SPA through the workspace response.

const choice = {
  id: '5eed0000-0000-4000-8000-000000000001',
  name: 'W',
  role: 'admin',
  companies: 1,
};

describe('workspace module toggles in the contract (PS-024)', () => {
  it('[PLAT-2][WEB-1] every workspace in the picker response carries modules.website_connector', () => {
    expect(
      WorkspaceChoiceSchema.parse({ ...choice, modules: { website_connector: false } }).modules,
    ).toEqual({ website_connector: false });
    expect(WorkspaceChoiceSchema.safeParse(choice).success).toBe(false);
    expect(
      WorkspaceChoiceSchema.safeParse({ ...choice, modules: { website_connector: 'yes' } }).success,
    ).toBe(false);
  });

  it('[PLAT-2] accepting an invite takes the name as optional', () => {
    const body = acceptInvite.body;
    const token = 'x'.repeat(43);
    expect(body.safeParse({ token, password: 'p' }).success).toBe(true);
    expect(body.safeParse({ token, name: 'Sam', password: 'p' }).success).toBe(true);
    expect(body.safeParse({ token, name: '  ', password: 'p' }).success).toBe(false);
  });
});
