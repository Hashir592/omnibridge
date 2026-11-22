import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// T-0317 on the MSW mock of the M09 stock routes (T-0901). No screenshot tests (ADR-046): axe
// and the flows. Each page load starts from the same seeded mock; the first SKU is on manual
// allocation, one SKU is oversold, and "eBay · kestrel-home" is paused (its writes are held).
const MANUAL_SKU = '/stock/0c0a1e9d-0000-4000-8000-000000000001';

async function expectNoSeriousA11yIssues(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

const allocation = (page: Page, account: string) =>
  // A plain string name matches as a substring, so no pattern is built from input.
  page.getByRole('textbox', { name: `Allocation for ${account}` });

test('[INV-6] the Oversold view lists the oversold SKU and its page says so', async ({ page }) => {
  await page.goto('/stock?view=oversold');
  const table = page.getByRole('table', { name: 'Stock by SKU' });
  await expect(table.getByText('Oversold')).toBeVisible();
  await expectNoSeriousA11yIssues(page);
  await table.getByRole('link').first().click();
  await expect(page.getByRole('alert')).toContainText('Oversold by 3.');
});

test('[INV-10] [AT-27] a manual allocation over stock is capped, warned, and saved', async ({
  page,
}) => {
  await page.goto(MANUAL_SKU);
  await expect(page.getByRole('table', { name: 'Stock by channel' })).toBeVisible();
  await expectNoSeriousA11yIssues(page);

  await page.getByRole('button', { name: 'Edit allocation' }).click();
  await allocation(page, 'Amazon UK · Northfield').fill('300');
  await expect(page.getByText('Capped by stock').first()).toBeVisible();
  await expect(
    page.getByText('More allocated than you have. Listings will be capped by stock.'),
  ).toBeVisible();
  await allocation(page, 'Amazon UK · Northfield').fill('x');
  await expect(page.getByRole('button', { name: 'Save allocation' })).toBeDisabled();
  await allocation(page, 'Amazon UK · Northfield').fill('300');
  await expectNoSeriousA11yIssues(page);

  await page.getByRole('button', { name: 'Save allocation' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Save allocation' }).click();
  const results = page.getByRole('list', { name: 'Push results' });
  await expect(page.getByText('Allocation saved', { exact: true })).toBeVisible();
  await expect(results).toContainText('New quantity on its way');
  await expect(results).toContainText('Held: sends when the account resumes');
  await expect(page.getByRole('table', { name: 'Stock by channel' })).toContainText(
    '300 set, 0 sold',
  );
});

test('[INV-10] a save after stock moved asks to review again, then goes through', async ({
  page,
}) => {
  await page.goto(MANUAL_SKU);
  await page.getByRole('button', { name: 'Edit allocation' }).click();
  await allocation(page, 'Amazon UK · Northfield').fill('50');
  // Someone books stock in while the form is open (the same page's mock, as another tab would).
  const status = await page.evaluate(async (path) => {
    const r = await fetch(`/api${path}/stock-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quantity: 5, client_ref: crypto.randomUUID() }),
    });
    return r.status;
  }, MANUAL_SKU);
  expect(status).toBe(201);

  await page.getByRole('button', { name: 'Save allocation' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Save allocation' }).click();
  await expect(
    page.getByText('Stock or settings changed while you were editing. Review and save again.'),
  ).toBeVisible();
  await expect(page.getByText('205', { exact: true })).toBeVisible();
  await expect(allocation(page, 'Amazon UK · Northfield')).toHaveValue('50');

  await page.getByRole('button', { name: 'Save allocation' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Save allocation' }).click();
  await expect(page.getByText('Allocation saved', { exact: true })).toBeVisible();
});

test('[INV-10] Back to Auto pushes every listing and shows each result', async ({ page }) => {
  await page.goto(MANUAL_SKU);
  await page.getByRole('radio', { name: 'Auto' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Switch to Auto' }).click();
  await expect(page.getByText('Back on Auto: every listing was pushed')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Push results' }).getByRole('listitem')).toHaveCount(
    4,
  );
  await expect(page.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
  // The final result arrives with the next read.
  await expect(
    page.getByRole('table', { name: 'Stock by channel' }).getByText('Sent').first(),
  ).toBeVisible();
});

test('[INV-3] [INV-5] stock in and an adjustment go in the change log', async ({ page }) => {
  await page.goto(MANUAL_SKU);
  await page.getByRole('button', { name: 'Stock in' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Units received').fill('24');
  await dialog.getByLabel('Supplier').fill('Marlow Supply');
  await expectNoSeriousA11yIssues(page);
  await dialog.getByRole('button', { name: 'Book stock in' }).click();
  await expect(page.getByText('Stock booked in')).toBeVisible();
  const log = page.getByRole('table', { name: 'Stock movements' });
  await expect(log.getByRole('row').nth(1)).toContainText('+24');
  await expect(log.getByRole('row').nth(1)).toContainText('From Marlow Supply');

  await page.getByRole('button', { name: 'Adjust stock' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Change').fill('-2');
  await dialog.getByRole('combobox', { name: 'Reason' }).click();
  await page.getByRole('option', { name: 'Other' }).click();
  await dialog.getByRole('button', { name: 'Save adjustment' }).click();
  await expect(dialog.getByText('Say what happened')).toBeVisible();
  await dialog.getByLabel('What happened').fill('Sample sent to a supplier');
  await dialog.getByRole('button', { name: 'Save adjustment' }).click();
  await expect(log.getByRole('row').nth(1)).toContainText('−2');
  await expect(log.getByRole('row').nth(1)).toContainText('Sample sent to a supplier');
});

test('[INV-5] the change log filters by kind and exports a CSV', async ({ page }) => {
  await page.goto('/stock/movements?kind=stock_in');
  const table = page.getByRole('table', { name: 'Stock change log' });
  await expect(table.getByText('Stock in').first()).toBeVisible();
  await expect(table.getByText('Dispatched')).toHaveCount(0);
  await expectNoSeriousA11yIssues(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  expect((await download).suggestedFilename()).toMatch(/^stock-change-log-\d{4}-\d{2}-\d{2}\.csv$/);
});

test('[INV-2] an account buffer saves, and a listing can use its own', async ({ page }) => {
  await page.goto('/stock/buffers');
  const input = page.getByRole('textbox', { name: 'Buffer for eBay · northfield-trading' });
  await expect(input).toHaveValue('1');
  await expectNoSeriousA11yIssues(page);
  await input.fill('3');
  await input.locator('xpath=ancestor::li').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Buffer saved')).toBeVisible();

  await page.goto(MANUAL_SKU);
  await page
    .getByRole('button', { name: /^Change the buffer of / })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Its own buffer').check();
  await dialog.getByLabel('Units kept back').fill('4');
  await dialog.getByRole('button', { name: 'Save buffer' }).click();
  await expect(page.getByRole('table', { name: 'Stock by channel' })).toContainText('This listing');
});
