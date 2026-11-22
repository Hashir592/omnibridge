import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// T-0316 on the MSW mock of the M08 catalogue routes (T-0801). No screenshot tests (ADR-046):
// axe and the flows. Each page load starts from the same seeded mock.

async function expectNoSeriousA11yIssues(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

test('[CAT-5] mapping a listing from the Unmapped queue takes it off the queue', async ({
  page,
}) => {
  await page.goto('/stock/listings');
  const table = page.getByRole('table', { name: 'Unmapped listings' });
  await expect(table).toBeVisible();
  await expect(page.getByText(/1–23 of 23 listings|1-23 of 23 listings/)).toBeVisible();
  await expectNoSeriousA11yIssues(page);

  await page.getByRole('button', { name: 'Map listing og-cop-m158' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Master SKU' }).click();
  await page.getByRole('option', { name: /OG-COP-M158/ }).click();
  await expectNoSeriousA11yIssues(page);
  await dialog.getByRole('button', { name: 'Map listing' }).click();

  await expect(page.getByText('Listing mapped')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Map listing og-cop-m158' })).toHaveCount(0);
  await expect(page.getByText(/of 22 listings/)).toBeVisible();
});

test('[CAT-5] a mapped listing unmaps back to the queue after asking', async ({ page }) => {
  await page.goto('/stock/listings?view=mapped');
  const first = page.getByRole('button', { name: /^Unmap listing / }).first();
  const name = (await first.getAttribute('aria-label'))?.slice('Unmap listing '.length) ?? '';
  await first.click();
  await expect(page.getByRole('alertdialog')).toContainText('goes back to the Unmapped queue');
  await page.getByRole('button', { name: 'Unmap listing', exact: true }).click();
  await expect(page.getByText('Listing unmapped')).toBeVisible();
  // Mock state lives in the page, so stay on it: back to the queue, then search.
  await page.getByRole('tab', { name: 'Unmapped' }).click();
  await page.getByLabel('Search by listing SKU, listing ID or title').fill(name);
  await expect(page.getByRole('button', { name: `Map listing ${name}` }).first()).toBeVisible();
});

test('[CAT-3] a bundle holds one SKU, needs a pack of 2 or more, and locks VAT and COGS', async ({
  page,
}) => {
  await page.goto('/stock/skus');
  await expect(page.getByRole('table', { name: 'Master SKUs' })).toBeVisible();
  await expectNoSeriousA11yIssues(page);

  await page.getByRole('button', { name: 'New SKU' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('Bundle of one SKU').check();
  await sheet.getByLabel('SKU code').fill('BB-BAM-M176-3PK');
  await sheet.getByLabel('Title').fill('Bamboo baby bib, medium, pack of 3');
  await sheet.getByLabel('Short description').fill('Bamboo baby bibs x3');
  await sheet.getByPlaceholder('Type a SKU code or title').fill('BB-BAM-M176');
  await page.getByRole('option', { name: /^BB-BAM-M176 · / }).click();
  await sheet.getByLabel('Units in the pack').fill('1');
  await sheet.getByLabel('Weight (g)').fill('240');
  // No VAT type or COGS fields for a bundle: it takes its component's.
  await expect(sheet.getByText('VAT type', { exact: true })).toHaveCount(0);
  await expectNoSeriousA11yIssues(page);

  await sheet.getByRole('button', { name: 'Create bundle' }).click();
  await expect(sheet.getByText('A bundle holds 2 to 1,000 units')).toBeVisible();
  await sheet.getByLabel('Units in the pack').fill('3');
  await sheet.getByRole('button', { name: 'Create bundle' }).click();

  await expect(page.getByRole('heading', { name: 'BB-BAM-M176-3PK' })).toBeVisible();
  await expect(page.getByText(/Bundle of 3 ×/)).toBeVisible();
  await expect(page.getByText(/VAT type follows its component/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change VAT type' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Set COGS' })).toHaveCount(0);
  await expectNoSeriousA11yIssues(page);
});

test('[CAT-4] COGS import checks the file first and applies all rows or none', async ({ page }) => {
  await page.goto('/stock/skus');
  await page.getByRole('button', { name: 'Import COGS' }).click();
  const dialog = page.getByRole('dialog');
  const file = (text: string) => ({
    name: 'cogs.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(text),
  });

  await dialog
    .locator('input[type="file"]')
    .setInputFiles(
      file('sku,cogs,effective_from\nBB-BAM-M176,4.20,01/11/2026\nNOPE-1,2.00,01/11/2026\n'),
    );
  await expect(dialog.getByText(/1 of 2 rows have a problem/)).toBeVisible();
  await expect(dialog.getByRole('table', { name: 'Rows with a problem' })).toContainText(
    'No Master SKU has this code.',
  );
  await expect(dialog.getByRole('button', { name: /^Import 2/ })).toHaveCount(0);
  await expectNoSeriousA11yIssues(page);

  await dialog
    .locator('input[type="file"]')
    .setInputFiles(file('sku,cogs,effective_from\nBB-BAM-M176,4.20,01/11/2026\n'));
  await dialog.getByRole('button', { name: 'Import 1 COGS rows' }).click();
  await expect(dialog.getByText('Imported 1 COGS rows.')).toBeVisible();
});

test('[CAT-4] setting a COGS from a date adds it to the history', async ({ page }) => {
  await page.goto('/stock/skus?q=BB-BAM-M176');
  await page.getByRole('link', { name: 'BB-BAM-M176', exact: true }).click();
  await page.getByRole('button', { name: 'Set COGS' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('COGS per unit (£)').fill('9.876');
  await dialog.getByRole('button', { name: 'Save COGS' }).click();
  await expect(dialog.getByText('Enter the cost in pounds, for example 12.34')).toBeVisible();
  await dialog.getByLabel('COGS per unit (£)').fill('9.87');
  await dialog.getByRole('button', { name: 'Save COGS' }).click();
  await expect(page.getByRole('list', { name: 'COGS history' })).toContainText('£9.87');
});

test('[CAT-2] VAT rates list every type and admins can add a rate', async ({ page }) => {
  await page.goto('/stock/vat-rates');
  const table = page.getByRole('table', { name: 'VAT rates' });
  await expect(table).toContainText('Zero-rated');
  await expect(table).toContainText('No VAT');
  await expectNoSeriousA11yIssues(page);
  await page.getByRole('button', { name: 'Add rate' }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'Orders placed before the date keep the old rate.',
  );
});
