import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// T-0302 component kit, on the dev-only gallery route /__ui (synthetic data).
const NOW = new Date('2026-10-19T10:00:00Z');

async function openGallery(page: Page): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto('/__ui');
  await expect(page.getByRole('heading', { name: 'Component gallery' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function seriousA11yIssues(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

test('[NFR-8] the component gallery has no serious or critical accessibility violations', async ({
  page,
}) => {
  await openGallery(page);
  expect(await seriousA11yIssues(page)).toEqual([]);
});

test('[NFR-8] an open dialog has no serious or critical accessibility violations', async ({
  page,
}) => {
  await openGallery(page);
  await page.getByRole('button', { name: 'Open dialog' }).click();
  await expect(page.getByRole('dialog', { name: 'Change carrier service' })).toBeVisible();
  expect(await seriousA11yIssues(page)).toEqual([]);
});

test('[NFR-8] dialog, sheet and confirm work with the keyboard and return focus', async ({
  page,
}) => {
  await openGallery(page);
  const trigger = page.getByRole('button', { name: 'Open dialog' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Change carrier service' });
  await expect(dialog).toBeVisible();
  // Focus is trapped: tabbing many times never leaves the dialog.
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.getByRole('button', { name: 'Open sheet' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Add reminder' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Add reminder' })).toBeHidden();

  await page.getByRole('button', { name: 'Delete 3 notes' }).focus();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('alertdialog', { name: 'Delete 3 notes?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Delete 3 notes' }).focus();
  await page.keyboard.press('Enter');
  await expect(confirm).toBeHidden();
  await expect(page.getByText('3 notes deleted')).toBeVisible();
});

test('[NFR-8] select, combobox and date picker work with the keyboard alone', async ({ page }) => {
  await openGallery(page);

  await page.getByRole('combobox', { name: /Carrier service/ }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('option', { name: 'DPD Next Day' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('combobox', { name: /Carrier service/ })).toHaveText(/DPD Next Day/);

  const sku = page.getByRole('combobox', { name: 'SKU' });
  await sku.focus();
  await page.keyboard.type('10042');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(sku).toHaveValue(/SKU-10042/);

  await page.getByRole('button', { name: 'Choose date from calendar' }).first().focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('grid', { name: 'October 2026' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Stored as 2026-10-20, shown as 20/10/2026')).toBeVisible();
});
