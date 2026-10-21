import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// T-0303 auth screens on the MSW mock (PROPOSED SHAPES, PS-016). Synthetic values only: the demo
// password and code below exist only in apps/ui/src/mocks/auth.ts.
const NOW = new Date('2026-10-19T10:00:00Z');
const DEMO_PASSWORD = 'synthetic demo only';
const DEMO_TOTP = '123456';

async function open(page: Page, path: string, heading: string): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function expectNoSeriousA11yIssues(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('[NFR-8] sign-in matches the locked reference design', async ({ page }) => {
  await open(page, '/sign-in', 'Sign in');
  await expect(page).toHaveScreenshot('sign-in.png');
});

const screens = [
  { path: '/sign-in', heading: 'Sign in' },
  { path: '/sign-in/code', heading: 'Enter your code' },
  { path: '/sign-in/recovery', heading: 'Use a recovery code' },
  { path: '/sign-in/set-up-mfa', heading: 'Set up two-step sign in' },
  { path: '/forgot-password', heading: 'Reset your password' },
  { path: '/reset-password?token=demo-reset', heading: 'Choose a new password' },
  { path: '/reset-password?token=expired', heading: 'This link no longer works' },
  { path: '/invite/demo-invite', heading: 'Join Demo workspace' },
  { path: '/invite/expired', heading: 'This link no longer works' },
  { path: '/workspaces', heading: 'Choose a workspace' },
] as const;

for (const s of screens) {
  test(`[NFR-8] ${s.path} has no serious or critical accessibility violations`, async ({
    page,
  }) => {
    await open(page, s.path, s.heading);
    await expectNoSeriousA11yIssues(page);
  });
}

test('[NFR-8] auth screens work on a phone-width screen without the side panel', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/sign-in', 'Sign in');
  await expect(page.getByRole('complementary', { name: 'About OmniBridge' })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('[USR-5] an unknown email and a wrong password show the same message', async ({ page }) => {
  await open(page, '/sign-in', 'Sign in');
  await signIn(page, 'nobody@example.test', 'wrong password');
  const unknown = await page.getByRole('alert').innerText();
  await signIn(page, 'sam.admin@example.test', 'wrong password');
  await expect(page.getByRole('alert')).toHaveText(unknown);
  expect(unknown).toContain('Email or password is incorrect.');
  await expectNoSeriousA11yIssues(page);
});

test('[USR-5] ten failures lock sign in for 15 minutes without saying the email exists', async ({
  page,
}) => {
  await open(page, '/sign-in', 'Sign in');
  for (let i = 0; i < 10; i++) await signIn(page, 'nobody@example.test', `wrong ${String(i)}`);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Too many failed attempts');
  await expect(alert).toContainText('15 minutes');
  await expect(alert).toContainText('If the email has an account');
});

test('[USR-4] sign in, code and workspace picker work with the keyboard alone', async ({
  page,
}) => {
  await open(page, '/sign-in', 'Sign in');
  await page.keyboard.type('sam.admin@example.test');
  await page.keyboard.press('Tab');
  await page.keyboard.type(DEMO_PASSWORD);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
  // The code field has focus and submits itself at the sixth digit.
  await page.keyboard.type(DEMO_TOTP);
  await expect(page.getByRole('heading', { name: 'Choose a workspace' })).toBeVisible();
  // The list loads after the heading: wait for it, or Tab can land past it.
  await expect(page.getByRole('button', { name: /Demo workspace/ }).first()).toBeVisible();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/$/);
});

test('[USR-4] a new user cannot get past MFA set-up without saving 10 recovery codes', async ({
  page,
}) => {
  await open(page, '/sign-in', 'Sign in');
  await signIn(page, 'new.user@example.test', DEMO_PASSWORD);
  await expect(page.getByRole('heading', { name: 'Set up two-step sign in' })).toBeVisible();
  await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
  await page.getByLabel('Authentication code').fill(DEMO_TOTP);
  await page.getByRole('button', { name: 'Turn on two-step sign in' }).click();
  await expect(
    page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem'),
  ).toHaveCount(10);
  const next = page.getByRole('button', { name: 'Continue to OmniBridge' });
  await expect(next).toBeDisabled();
  await page.getByLabel('I have saved these codes somewhere safe').check();
  await expect(next).toBeEnabled();
  await expectNoSeriousA11yIssues(page);
});

test('[USR-3] [TEN-7] accepting an invite checks the password rules', async ({ page }) => {
  await open(page, '/invite/demo-invite', 'Join Demo workspace');
  await page.getByLabel('Full name').fill('New User');
  await page.getByLabel('Password', { exact: true }).fill('newuser plus more');
  const rules = page.getByRole('list', { name: 'Password rules' });
  await expect(rules.getByRole('listitem').nth(0)).toContainText('(done)');
  await expect(rules.getByRole('listitem').nth(1)).toContainText('(not yet)');
  await page.getByLabel('Password', { exact: true }).fill('my password 2026x');
  await page.getByLabel('Confirm password').fill('my password 2026x');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toContainText('leaked passwords');
  await page.getByLabel('Password', { exact: true }).fill('calm river lantern');
  await page.getByLabel('Confirm password').fill('calm river lantern');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Set up two-step sign in' })).toBeVisible();
});

test('[USR-7] forgot password gives the same answer for any email', async ({ page }) => {
  await open(page, '/forgot-password', 'Reset your password');
  await page.getByRole('textbox', { name: 'Email' }).fill('nobody@example.test');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.getByText('If an account uses')).toBeVisible();
  await expect(page.getByText('30 minutes')).toBeVisible();
});

test('[USR-7] a reset keeps MFA in place', async ({ page }) => {
  await open(page, '/reset-password?token=demo-reset', 'Choose a new password');
  await page.getByLabel('New password', { exact: true }).fill('calm river lantern');
  await page.getByLabel('Confirm new password').fill('calm river lantern');
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();
  await expect(page.getByText('You will still need the code')).toBeVisible();
});
