import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// T-0301 design mock-ups: every locked screen matches its reference screenshot and has no
// serious or critical accessibility violations. The clock is fixed, so the seeded synthetic data
// and every relative date ("Today", "Overdue 2 days") are the same on every run.
const NOW = new Date('2026-10-19T10:00:00Z');

async function open(page: Page, path: string, ready: string): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto(path);
  await expect(page.getByText(ready).first()).toBeVisible();
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

const screens = [
  { name: 'home', path: '/', ready: 'Needs action' },
  { name: 'orders', path: '/orders', ready: 'of 500 orders' },
  { name: 'order-detail', path: '/orders/ord_0039', ready: 'Ship to' },
  { name: 'shipping', path: '/shipping', ready: 'Pick orders to ship' },
] as const;

for (const s of screens) {
  test(`[NFR-8] ${s.name} matches the locked reference design`, async ({ page }) => {
    await open(page, s.path, s.ready);
    await expect(page).toHaveScreenshot(`${s.name}.png`);
  });

  test(`[NFR-8] ${s.name} has no serious or critical accessibility violations`, async ({
    page,
  }) => {
    await open(page, s.path, s.ready);
    await expectNoSeriousA11yIssues(page);
  });
}

test.describe('tablet width', () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

  for (const s of [screens[1], screens[3]]) {
    test(`[NFR-8] ${s.name} works on a tablet and matches the reference`, async ({ page }) => {
      await open(page, s.path, s.ready);
      await expect(page).toHaveScreenshot(`${s.name}-tablet.png`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        820,
      );
      await expectNoSeriousA11yIssues(page);
    });
  }
});

test('[NFR-9] orders show UK money, DD/MM/YYYY dates and masked buyers', async ({ page }) => {
  await open(page, '/orders', 'of 500 orders');
  const table = page.getByRole('table', { name: 'Orders' });
  await expect(table.getByText(/^£\d{1,3}(,\d{3})*\.\d{2}$/).first()).toBeVisible();
  await expect(table.getByText(/\d{2}\/\d{2}\/2026/).first()).toBeVisible();
  // [ORD-5] buyers are masked in the list
  await expect(table.getByText(/^[A-Z]\. [A-Z]\*\*\*, /).first()).toBeVisible();
});

test('[NFR-8] the shell, table and bulk bar work with the keyboard alone', async ({ page }) => {
  await open(page, '/orders', 'of 500 orders');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('combobox')).toBeFocused();
  await page.keyboard.type('Ship');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/shipping/);

  await page.goto('/orders');
  await expect(page.getByText('of 500 orders')).toBeVisible();
  const first = page.getByRole('checkbox', { name: /^Select order / }).first();
  await first.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('region', { name: 'Bulk actions' })).toContainText('1 selected');
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
});

test('[TEN-5] the company switcher narrows every figure to one company', async ({ page }) => {
  await open(page, '/orders', 'of 500 orders');
  await page.getByRole('button', { name: /Company:/ }).click();
  await page.getByRole('menuitemradio', { name: 'Kestrel Home' }).click();
  await expect(page.getByText(/of \d+ orders/)).not.toHaveText(/of 500 orders/);
});

test('[PERM-3] a child user sees only the tabs they were given', async ({ page }) => {
  await open(page, '/', 'Needs action');
  await page.getByRole('button', { name: /Sam Admin/ }).click();
  await page.getByRole('menuitemradio', { name: /Pat Packer/ }).click();
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link')).toHaveText([/Home/, /Orders/, /Shipping/]);
  await expect(page.getByRole('heading', { name: 'Sales' })).toHaveCount(0);
});
