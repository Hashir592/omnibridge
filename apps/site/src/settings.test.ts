import { describe, expect, it } from 'vitest';
import { PLACEHOLDERS, readSettings } from './settings.ts';

const filled = {
  OB_SITE_OPERATOR_LEGAL_NAME: 'Synthetic Operator Ltd',
  OB_SITE_OPERATOR_COMPANY_NUMBER: '00000000',
  OB_SITE_OPERATOR_REGISTERED_ADDRESS: '1 Example Street, Testtown, TE1 1ST',
};

describe('site settings (WWW-2)', () => {
  it('[WWW-2] the footer values come from settings, with placeholders until they are set', () => {
    expect(readSettings({})).toEqual(PLACEHOLDERS);
    expect(readSettings(filled)).toEqual({
      operatorLegalName: 'Synthetic Operator Ltd',
      operatorCompanyNumber: '00000000',
      operatorRegisteredAddress: '1 Example Street, Testtown, TE1 1ST',
    });
  });

  it('[WWW-2] a production build fails while any Operator detail is a placeholder', () => {
    expect(() => readSettings({ OB_SITE_PRODUCTION: '1' })).toThrow(/OB_SITE_OPERATOR_LEGAL_NAME/);
    expect(() =>
      readSettings({ ...filled, OB_SITE_OPERATOR_COMPANY_NUMBER: ' ', OB_SITE_PRODUCTION: '1' }),
    ).toThrow(/OB_SITE_OPERATOR_COMPANY_NUMBER/);
    expect(readSettings({ ...filled, OB_SITE_PRODUCTION: '1' }).operatorLegalName).toBe(
      'Synthetic Operator Ltd',
    );
  });
});
