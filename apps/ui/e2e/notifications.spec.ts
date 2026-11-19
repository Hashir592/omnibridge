import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// T-0312 notification centre and email choices on the MSW mock, which follows the T-0501 and
// T-0502 routes (PS-030, PS-031). No screenshot tests (ADR-046): axe, keyboard and the flows.
// Seed: the admin has 4 unread (oversold, tracking, auth lost, health band), 8 read or resolved.
const NOW = new Date('2026-10-21T10:00:00Z');
const OVERSOLD = '00000000-0000-4000-8000-000000000002';

async function open(page: Page, path: string, heading: string): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function openHome(page: Page): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^Notifications, \d+ unread$/ })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

const bell = (page: Page, unread: number) =>
  page.getByRole('button', { name: `Notifications, ${String(unread)} unread` });

async function expectNoSeriousA11yIssues(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

test('[NFR-8] the notification centre and the email choices have no serious accessibility issues', async ({
  page,
}) => {
  await open(page, '/notifications', 'Notifications');
  await expect(page.getByRole('link', { name: /Oversold/ })).toBeVisible();
  await expectNoSeriousA11yIssues(page);
  await open(page, '/notifications?view=email', 'Notifications');
  await expect(page.getByRole('table', { name: 'Notification emails' })).toBeVisible();
  await expectNoSeriousA11yIssues(page);
});

test('[NTF-1] the bell counts unread; opening one marks it read and goes to its record', async ({
  page,
}) => {
  await openHome(page);
  await expect(bell(page, 4)).toBeVisible();
  await bell(page, 4).click();
  const row = page.getByRole('link', { name: /Critical: Oversold/ });
  // Title, the record it is about and what the params count, signal and state (NTF-1).
  await expect(row).toContainText('SKU · 3 affected');
  await expect(row).toContainText('Derived');
  await expect(row.getByLabel('Unread')).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(/\/stock\?view=oversold/);
  await expect(bell(page, 3)).toBeVisible();
  await bell(page, 3).click();
  await expect(
    page.getByRole('link', { name: /Critical: Oversold/ }).getByLabel('Unread'),
  ).toHaveCount(0);
});

test('[NTF-1] mark all read clears the count; resolved ones stay resolved', async ({ page }) => {
  await openHome(page);
  await bell(page, 4).click();
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(bell(page, 0)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark all read' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Unread 0' }).click();
  await expect(page.getByText('Nothing unread')).toBeVisible();
  await page.getByRole('tab', { name: 'All' }).click();
  await expect(page.getByText('Resolved itself')).toBeVisible();
});

test('[NTF-1] the centre filters by state and severity from the address', async ({ page }) => {
  await open(page, '/notifications?state=resolved', 'Notifications');
  await expect(page.getByRole('link')).toContainText([/New eBay message/]);
  await expect(page.getByRole('link', { name: /Oversold/ })).toHaveCount(0);
  await open(page, '/notifications?severity=critical', 'Notifications');
  await expect(page.getByRole('link', { name: /Critical: Oversold/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Warning:/ })).toHaveCount(0);
  await open(page, '/notifications?state=resolved&severity=critical', 'Notifications');
  await expect(page.getByText('Nothing matches these filters')).toBeVisible();
});

test('[NTF-1] an email link opens the centre on its notification and marks it read', async ({
  page,
}) => {
  await open(page, `/notifications/${OVERSOLD}`, 'Notifications');
  const row = page.getByRole('link', { name: /Critical: Oversold/ });
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(bell(page, 3)).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0);
});

test('[NTF-2] an email link to a notification this user cannot see says so', async ({ page }) => {
  await open(page, '/notifications/00000000-0000-4000-8000-000000009999', 'Notifications');
  await expect(page.getByRole('status')).toContainText('no longer available to you');
  await expect(page.getByRole('link', { name: /Critical: Oversold/ })).toBeVisible();
});

test('[NTF-4] critical types are locked on for an admin; the others switch with the keyboard', async ({
  page,
}) => {
  await open(page, '/notifications?view=email', 'Notifications');
  const locked = page.getByRole('checkbox', {
    name: /Email me about Oversold/,
  });
  await expect(locked).toBeChecked();
  await expect(locked).toBeDisabled();
  await expect(page.getByText('Always on for admins').first()).toBeVisible();
  const bill = page.getByRole('checkbox', { name: /Email me about Reminder due/ });
  await expect(bill).not.toBeChecked();
  await bill.focus();
  await page.keyboard.press('Space');
  await expect(page.getByText('Emails on')).toBeVisible();
  await expect(bill).toBeChecked();
});

test('[NTF-4] Settings shows the same email choices', async ({ page }) => {
  await open(page, '/settings?section=notifications', 'Settings');
  await expect(page.getByRole('table', { name: 'Notification emails' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Email me about Oversold/ })).toBeDisabled();
});
