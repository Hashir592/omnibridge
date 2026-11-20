import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// T-0314 on the MSW mock of the M07 routes (T-0701, T-0702). No screenshot tests (ADR-046):
// axe and the flows. The mock pauses "eBay · kestrel-home" and needs re-authorisation on
// "Amazon UK · Harbour".
const NOW = new Date('2026-11-21T10:00:00Z');

async function expectNoSeriousA11yIssues(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

const card = (page: Page, name: string) =>
  page
    .locator('section')
    .filter({ has: page.getByText(name, { exact: true }) })
    .last();

test('[INT-4] [SAFE-2] pausing an account asks first and shows it paused', async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await page.goto('/connections');
  await expect(page.getByText('Sales channels')).toBeVisible();
  await expect(page.getByTestId('paused-line')).toHaveCount(1);

  const amazon = card(page, 'Amazon UK · Northfield');
  await amazon.getByRole('checkbox', { name: /Kill switch/ }).click();
  await page.getByRole('button', { name: 'Pause writes' }).click();
  await expect(page.getByTestId('paused-line')).toHaveCount(2);
  await expectNoSeriousA11yIssues(page);

  await amazon.getByRole('checkbox', { name: /Kill switch/ }).click();
  await expect(page.getByTestId('paused-line')).toHaveCount(1);
});

test('[INT-4] [SAFE-2] the detail sheet shows streams and tokens, and the paused line', async ({
  page,
}) => {
  await page.clock.setFixedTime(NOW);
  await page.goto('/connections');
  await card(page, 'eBay · kestrel-home').getByRole('button', { name: 'Details' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('table', { name: 'Sync streams' })).toBeVisible();
  await expect(sheet.getByTestId('paused-line')).toBeVisible();
  await expect(sheet).toContainText('ebay.refresh_token');
  await expectNoSeriousA11yIssues(page);
});

test('[INT-4] re-authorising comes back connected', async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await page.goto('/connections');
  await card(page, 'Amazon UK · Harbour').getByRole('button', { name: 'Re-authorise' }).click();
  await expect(page.getByText('Account connected')).toBeVisible();
  await expect(page).toHaveURL(/\/connections$/);
});

test('[SAFE-1] [SAFE-2] the bulk dialog names every account and marks the paused one', async ({
  page,
}) => {
  await page.goto('/__ui#bulk');
  await page.getByRole('button', { name: 'Push stock to 3 accounts' }).first().click();
  const list = page.getByRole('list', { name: 'Accounts this reaches' });
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list.getByRole('listitem').filter({ hasText: 'kestrel-home' })).toContainText(
    'Paused',
  );
  await expectNoSeriousA11yIssues(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Push stock to 3 accounts' }).click();
  await expect(page.getByText('Push stock: 3 accounts')).toBeVisible();
});
