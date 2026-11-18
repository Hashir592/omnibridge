import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// T-0308 buyer data requests on the MSW mock, which follows the T-0404 routes. No screenshot
// tests (ADR-046): axe, keyboard and the admin flow. Synthetic buyers only (example.com).
const NOW = new Date('2026-10-21T10:00:00Z');
const PATH = '/users/buyer-data';
const HEADING = 'Buyer data requests';

async function open(page: Page): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto(PATH);
  await expect(page.getByRole('heading', { level: 1, name: HEADING })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Erasure requests' })).toBeVisible();
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

/** Nothing the admin typed about the buyer is kept by the browser, nor put in the URL. */
async function expectNothingStored(page: Page, value: string): Promise<void> {
  const stored = await page.evaluate(() => {
    const dump = (st: Storage) =>
      Array.from({ length: st.length }, (_, k) => {
        const key = st.key(k) ?? '';
        return `${key}=${st.getItem(key) ?? ''}`;
      }).join(' ');
    return `${dump(localStorage)} ${dump(sessionStorage)}`;
  });
  expect(stored.toLowerCase()).not.toContain(value.toLowerCase());
  expect(page.url().toLowerCase()).not.toContain(value.toLowerCase());
}

test('[NFR-8] the buyer data page has no serious or critical accessibility violations', async ({
  page,
}) => {
  await open(page);
  await expectNoSeriousA11yIssues(page);
});

test('[NFR-8] the masked matches and the delete dialog have no serious accessibility violations', async ({
  page,
}) => {
  // Its own test: axe does not finish under an installed fake clock (the flow test below).
  await open(page);
  await page.getByRole('textbox', { name: 'Buyer ID', exact: false }).fill('morgan_e_88');
  await page.getByRole('button', { name: 'Find records to delete' }).click();
  await expect(page.getByRole('table', { name: 'Matching records' })).toBeVisible();
  await expectNoSeriousA11yIssues(page);
  await page.getByRole('button', { name: 'Delete 3 records', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expectNoSeriousA11yIssues(page);
});

test('[DEL-4] an admin finds a buyer by keyboard, checks the masked matches and deletes them', async ({
  page,
}) => {
  await page.clock.install({ time: NOW });
  await page.goto('/users');
  await page.getByRole('link', { name: 'Buyer data requests' }).click();
  await expect(page.getByRole('heading', { level: 1, name: HEADING })).toBeVisible();

  await page.getByRole('textbox', { name: 'Email' }).fill('Morgan.Ellis@example.com');
  await page.keyboard.press('Enter');
  const matches = page.getByRole('table', { name: 'Matching records' });
  await expect(matches.getByRole('row')).toHaveCount(3);
  await expect(matches).toContainText('M. E***');
  await expect(matches).toContainText('m***@e***');
  await expect(matches).not.toContainText('morgan');
  await expect(page.getByText('due 21/11/2026')).toBeVisible();

  await page.getByRole('button', { name: 'Delete 2 records', exact: true }).first().click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('cannot be recovered');
  await dialog.getByRole('button', { name: 'Delete 2 records' }).click();
  await expect(page.getByText(/Deleting 2 records/)).toBeVisible();
  await page.clock.runFor(4_000);
  await expect(page.getByText(/2 records deleted on 21\/10\/2026/)).toBeVisible();
  await expectNothingStored(page, 'morgan.ellis');
});

test('[DEL-4] an open request past its due date shows as overdue', async ({ page }) => {
  await open(page);
  await expect(page.getByText('1 erasure request is past its due date.')).toBeVisible();
  await expect(page.getByRole('row', { name: /Overdue/ })).toHaveCount(1);
});

test('[DEL-4] confirming a request with nothing found marks it complete', async ({ page }) => {
  await open(page);
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Nobody Known');
  await page.getByRole('button', { name: 'Find records to delete' }).click();
  await expect(page.getByText('Nothing is held for these details')).toBeVisible();
  await page.getByRole('button', { name: 'Mark complete', exact: true }).first().click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Mark complete' }).click();
  await expect(page.getByText(/Request completed on/)).toBeVisible();
});

test('[DEL-4] [DEL-5] no detail entered: a plain message, and nothing is sent', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Find records to delete' }).click();
  await expect(page.getByRole('alert')).toHaveText('Enter at least one detail of the buyer.');
});

test('[DEL-5] an admin downloads everything held about one buyer as a JSON file', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('textbox', { name: 'Email' }).fill('riley.shaw@example.com');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download a copy for the buyer' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^buyer-data-export-\d{4}-\d{2}-\d{2}\.json$/);
  await expect(page.getByText('Export downloaded')).toBeVisible();
  await expectNothingStored(page, 'riley.shaw');
});

test('[DEL-5] too many matches: the server’s reason shows by the form', async ({ page }) => {
  await open(page);
  await page.getByRole('textbox', { name: 'Postcode' }).fill('M1 1AE');
  await page.getByRole('button', { name: 'Download a copy for the buyer' }).click();
  await expect(page.getByRole('alert')).toContainText('Too many records match');
});

test('[DEL-3] an admin downloads a channel account’s deletion certificate', async ({ page }) => {
  await open(page);
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download certificate for eBay · northfield-trading' })
    .click();
  expect((await download).suggestedFilename()).toMatch(/^deletion-certificate-ca_2-.+\.txt$/);
});

test('[DEL-4] [DEL-5] a child user has no menu item and no access by link', async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: /Sam Admin/ }).click();
  await page.getByRole('menuitemradio', { name: /Pat Packer/ }).click();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveText([
    /Home/,
    /Orders/,
    /Shipping/,
  ]);
  // Client-side navigation keeps the persona (a full reload resets the mock to the admin).
  await page.evaluate((path) => {
    history.pushState({}, '', path);
    dispatchEvent(new PopStateEvent('popstate'));
  }, PATH);
  await expect(page.getByText('You do not have access to this page')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Email' })).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Erasure requests' })).toHaveCount(0);
});
