/**
 * Site settings (WWW-2), read at build time from the environment so nothing about the Operator is
 * hard-coded. Until the client sends the Operator details the placeholders below are shown; a
 * production build (OB_SITE_PRODUCTION=1) refuses to finish while any placeholder is left.
 */
export interface SiteSettings {
  operatorLegalName: string;
  operatorCompanyNumber: string;
  operatorRegisteredAddress: string;
}

export const PLACEHOLDERS: SiteSettings = {
  operatorLegalName: '[OPERATOR_LEGAL_NAME]',
  operatorCompanyNumber: '[OPERATOR_COMPANY_NUMBER]',
  operatorRegisteredAddress: '[OPERATOR_REGISTERED_ADDRESS]',
};

const ENV_KEYS: Record<keyof SiteSettings, string> = {
  operatorLegalName: 'OB_SITE_OPERATOR_LEGAL_NAME',
  operatorCompanyNumber: 'OB_SITE_OPERATOR_COMPANY_NUMBER',
  operatorRegisteredAddress: 'OB_SITE_OPERATOR_REGISTERED_ADDRESS',
};

/** The date the privacy policy and terms were last changed (WWW-5, WWW-7). */
export const LEGAL_VERSION = '2026-11-15';

export const CONTACT = {
  support: 'support@omnibridge.co.uk',
  privacy: 'privacy@omnibridge.co.uk',
  security: 'security@omnibridge.co.uk',
} as const;

export const APP_URL = 'https://app.omnibridge.co.uk';

/** Settings from `env`; throws in production while a placeholder is left (WWW-2). */
export function readSettings(env: Record<string, string | undefined>): SiteSettings {
  const settings = { ...PLACEHOLDERS };
  for (const key of Object.keys(ENV_KEYS) as (keyof SiteSettings)[]) {
    const value = env[ENV_KEYS[key]]?.trim();
    if (value) settings[key] = value;
  }
  if (env.OB_SITE_PRODUCTION === '1') {
    const missing = (Object.keys(ENV_KEYS) as (keyof SiteSettings)[]).filter(
      (key) => settings[key] === PLACEHOLDERS[key],
    );
    if (missing.length > 0) {
      throw new Error(
        `production site build: Operator details still placeholders, set ${missing
          .map((key) => ENV_KEYS[key])
          .join(', ')}`,
      );
    }
  }
  return settings;
}
