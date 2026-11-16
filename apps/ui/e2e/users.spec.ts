import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// T-0204 user screens on the MSW mock, which follows the real contract: invite, edit ticks, remove,
// revoke and the quarterly access review. No screenshot tests (ADR-046): axe and keyboard only.
const NOW = new Date('2026-10-21T10:00:00Z');

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

/** Presses Tab until `target` has focus (at most `max` times). */
async function tabTo(page: Page, name: string | RegExp, max = 30): Promise<void> {
  const target = page.getByRole('button', { name });
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

for (const s of [
  { path: '/users', heading: 'Users' },
  { path: '/users/usr_2', heading: 'Pat Packer' },
  { path: '/users/inv_1', heading: 'robin.new@example.com' },
  { path: '/users/access-reviews', heading: 'Access reviews' },
] as const) {
  test(`[NFR-8] ${s.path} has no serious or critical accessibility violations`, async ({
    page,
  }) => {
    await open(page, s.path, s.heading);
    await expectNoSeriousA11yIssues(page);
  });
}

test('[USR-1] [PERM-6] invite a child user with ticks, by keyboard alone', async ({ page }) => {
  await open(page, '/users', 'Users');
  await expect(page.getByRole('table', { name: 'Users' })).toBeVisible();
  await tabTo(page, 'Invite user');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Invite a user' });
  await expect(dialog).toBeVisible();
  await expectNoSeriousA11yIssues(page);
  // The email field has focus; tick Orders with the keyboard.
  await page.keyboard.type('casey.new@example.com');
  const orders = dialog.getByRole('checkbox', { name: 'Orders' });
  for (let i = 0; i < 10 && !(await orders.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(orders).toBeFocused();
  await page.keyboard.press('Space');
  await expect(orders).toBeChecked();
  await tabTo(page, 'Send invite');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Invite sent')).toBeVisible();
  const row = page.getByRole('row', { name: /casey\.new@example\.com/ });
  await expect(row).toContainText('1 of 12');
  await expect(row).toContainText('Invited until');
});

test('[USR-1] inviting someone who is already a member shows the reason by the field', async ({
  page,
}) => {
  await open(page, '/users', 'Users');
  await page.getByRole('button', { name: 'Invite user' }).click();
  await page.getByRole('textbox', { name: 'Email' }).fill('pat.packer@example.com');
  await page.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByText('This person is already a member of this workspace')).toBeVisible();
});

test('[TEN-7] revoking an invite removes it from the list', async ({ page }) => {
  await open(page, '/users', 'Users');
  await page.getByRole('button', { name: 'Revoke invite for robin.new@example.com' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke invite' }).click();
  await expect(page.getByText('Invite revoked')).toBeVisible();
  await expect(page.getByRole('row', { name: /robin\.new@example\.com/ })).toHaveCount(0);
});

test('[PERM-2] saving a child user’s ticks and removing a user', async ({ page }) => {
  await open(page, '/users/usr_4', 'Jo Support');
  await page.getByRole('checkbox', { name: 'Finance' }).check();
  await page.getByRole('button', { name: 'Save access' }).click();
  await expect(page.getByText('Access saved')).toBeVisible();
  await page.getByRole('button', { name: 'Remove user' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove Jo Support' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
  await expect(page.getByRole('row', { name: /Jo Support/ })).toHaveCount(0);
});

test('[PERM-7] the server’s last-admin refusal (409) shows as a plain inline message', async ({
  page,
}) => {
  // Make Pat an admin, so the page lets Sam be demoted...
  await open(page, '/users/usr_2', 'Pat Packer');
  await page.getByRole('radio', { name: /^Admin/ }).check();
  await page.getByRole('button', { name: 'Save access' }).click();
  await expect(page.getByText('Access saved')).toBeVisible();
  await page.getByRole('link', { name: 'Back to users' }).click();
  await page.getByRole('link', { name: 'Sam Admin' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sam Admin' })).toBeVisible();
  // ...then, behind this page's back, Pat stops being an admin (another admin's change).
  await page.evaluate(async () => {
    await fetch('/users/usr_2/access', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'child', tabs: [], companyIds: [] }),
    });
  });
  await page.getByRole('radio', { name: /^Child/ }).check();
  await page.getByRole('button', { name: 'Save access' }).click();
  // After the refusal the list reloads, so the page's own last-admin check shows as well.
  const alert = page
    .getByRole('alert')
    .filter({ hasText: 'Every workspace needs at least one admin' });
  await expect(alert).toBeVisible();
  // Plain text: no tinted box behind it.
  expect(await alert.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    'rgba(0, 0, 0, 0)',
  );
});

test('[USR-9] completing the quarterly access review', async ({ page }) => {
  await open(page, '/users/access-reviews', 'Access reviews');
  await expect(page.getByRole('table', { name: 'Current access' })).toContainText('Pat Packer');
  await page.getByRole('button', { name: 'Mark review complete' }).click();
  await expect(page.getByText('Access review complete')).toBeVisible();
  await expect(page.getByText('Nothing to review now')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Completed reviews' }).getByRole('row')).toHaveCount(
    4,
  );
});
