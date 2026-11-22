import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// T-0305 client preview screens. No screenshot tests (ADR-046 keeps those to 4 key screens):
// each screen gets an axe check and a keyboard walkthrough instead. The clock is fixed so the
// seeded synthetic data is the same on every run.
const NOW = new Date('2026-10-21T10:00:00Z');

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

/**
 * Tabs through the page from the top of the content: every stop is a visible control, and focus
 * reaches at least 2 different ones (a tab strip is one stop). A short page may run out of controls first; that ends the walk.
 */
async function walkWithKeyboard(page: Page, steps = 12): Promise<void> {
  await page.locator('main').click({ position: { x: 2, y: 2 } });
  const seen = new Set<string>();
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const r = el.getBoundingClientRect();
      // Position is part of the key: a page may repeat the same button (for example Pause).
      const key = `${el.outerHTML.slice(0, 120)}@${String(Math.round(r.top))},${String(Math.round(r.left))}`;
      return { key, visible: r.width > 0 && r.height > 0 };
    });
    if (!stop) break;
    expect(stop.visible, `focused control is visible: ${stop.key}`).toBe(true);
    seen.add(stop.key);
  }
  expect(seen.size).toBeGreaterThanOrEqual(2);
}

const screens = [
  { name: 'stock list', path: '/stock', ready: 'of 200 SKUs' },
  { name: 'unmapped listings', path: '/stock/listings', ready: 'Not mapped' },
  { name: 'sales and profit', path: '/sales-profit', ready: 'How contribution profit is made' },
  { name: 'VAT quarters', path: '/finance', ready: 'VAT payable' },
  { name: 'expenses', path: '/finance?section=expenses', ready: 'Invoice date' },
  { name: 'profit and loss', path: '/finance?section=pnl', ready: 'Gross profit' },
  { name: 'Amazon health', path: '/account-health', ready: 'Order Defect Rate' },
  { name: 'eBay health', path: '/account-health?market=ebay', ready: 'Transaction defect rate' },
  { name: 'users', path: '/users', ready: 'Two-step sign-in' },
  { name: 'user access', path: '/users/usr_5', ready: 'Tabs this user can see' },
  { name: 'connections', path: '/connections', ready: 'Sales channels' },
  { name: 'eBay messages', path: '/customer-service', ready: 'Send reply' },
  { name: 'feedback', path: '/customer-service?section=feedback', ready: 'Latest eBay feedback' },
  {
    name: 'review requests',
    path: '/customer-service?section=reviews',
    ready: 'Daily review requests',
  },
  { name: 'ad campaigns', path: '/advertising', ready: 'Budget / day' },
  { name: 'ad rules', path: '/advertising?section=rules', ready: 'Safety caps' },
  { name: 'negative keywords', path: '/advertising?section=negatives', ready: 'Search term' },
  { name: 'forecasting', path: '/forecasting', ready: 'Suggested order' },
  { name: 'reminders', path: '/reminders', ready: 'Coming up' },
  { name: 'notes', path: '/notes', ready: 'Save note' },
  { name: 'audit log', path: '/audit-log', ready: 'Before → after' },
  { name: 'settings', path: '/settings', ready: 'Customer details kept' },
  {
    name: 'settings notifications',
    path: '/settings?section=notifications',
    ready: 'Always on for admins',
  },
  { name: 'my account', path: '/settings?section=security', ready: 'Where you are signed in' },
] as const;

for (const s of screens) {
  test(`[NFR-8] ${s.name} has no serious accessibility issues and works with the keyboard`, async ({
    page,
  }) => {
    await open(page, s.path, s.ready);
    await expectNoSeriousA11yIssues(page);
    await walkWithKeyboard(page);
  });
}

test('[NFR-8] password change has no serious accessibility issues and submits by keyboard', async ({
  page,
}) => {
  await open(page, '/sign-in/password-change', 'Current password');
  await expectNoSeriousA11yIssues(page);
  await page.keyboard.type('OldDemoPass2025');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Harbour-Lamp-River-42');
  await page.getByLabel('Confirm new password').fill('Harbour-Lamp-River-42');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();
});

test('[NFR-8] the notification panel opens, lists alerts and closes by keyboard', async ({
  page,
}) => {
  await open(page, '/', 'Needs action');
  await page.getByRole('button', { name: /^Notifications,/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Mark all read')).toBeVisible();
  await expectNoSeriousA11yIssues(page);
  await page.keyboard.press('Escape');
  await expect(page.getByText('Mark all read')).toBeHidden();
});

test('[PERM-3] user access: tab ticks change with the space bar', async ({ page }) => {
  await open(page, '/users/usr_5', 'Tabs this user can see');
  const finance = page.getByRole('checkbox', { name: 'Finance' });
  await finance.focus();
  await expect(finance).not.toBeChecked();
  await page.keyboard.press('Space');
  await expect(finance).toBeChecked();
});

test('[PERM-7] the only admin cannot be made a child', async ({ page }) => {
  await open(page, '/users/usr_1', 'Tabs this user can see');
  await page.getByRole('radio', { name: /^Child/ }).check();
  await expect(page.getByRole('alert')).toContainText('This is the only admin');
  await expect(page.getByRole('button', { name: 'Save access' })).toBeDisabled();
});

test('[TOOL-3] notes warn before saving text that looks like customer details', async ({
  page,
}) => {
  await open(page, '/notes', 'Save note');
  await page.getByRole('textbox', { name: 'Note' }).fill('Call 07700 900123 tomorrow');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByRole('alert')).toContainText('phone number');
});

test('[PERM-3] a child user opening an admin page by link sees no data', async ({ page }) => {
  await open(page, '/', 'Needs action');
  await page.getByRole('button', { name: /Sam Admin/ }).click();
  await page.getByRole('menuitemradio', { name: /Pat Packer/ }).click();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveText([
    /Home/,
    /Orders/,
    /Shipping/,
  ]);
  // Client-side navigation keeps the persona (a full reload resets the mock to the admin).
  await page.evaluate(() => {
    history.pushState({}, '', '/finance');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByText('You do not have access to this page')).toBeVisible();
  await expect(page.getByText('VAT payable')).toHaveCount(0);
});

test('[CS-6] Amazon messages: mark done moves a thread to Done, and back', async ({ page }) => {
  await open(page, '/customer-service?section=amazon', 'Send reply');
  const done = page.getByRole('tab', { name: /^Done/ });
  const before = Number((await done.textContent())?.replace(/\D/g, '') ?? 0);
  await page.getByRole('button', { name: 'Mark done' }).click();
  await expect(page.getByText('Marked done')).toBeVisible();
  await expect(done).toContainText(String(before + 1));
  await done.click();
  await page.getByRole('button', { name: 'Move to inbox' }).first().click();
  await expect(done).toContainText(String(before));
});

test('[CS-1] eBay messages: mark unread sticks, and archive moves the thread', async ({ page }) => {
  await open(page, '/customer-service', 'Send reply');
  await page.getByRole('button', { name: 'Mark unread' }).click();
  await expect(page.getByRole('button', { name: 'Mark read' })).toBeVisible();
  const archived = page.getByRole('tab', { name: /^Archived/ });
  const before = Number((await archived.textContent())?.replace(/\D/g, '') ?? 0);
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(archived).toContainText(String(before + 1));
});

test('[SHP-9] Ship together: untick an order, or take it out of the group', async ({ page }) => {
  await open(page, '/orders?placed=today&channel=ca_3', 'Placed: Today');
  await page.getByRole('button', { name: /^Same buyer, 3 orders/ }).click();
  await page.getByRole('menuitem', { name: 'Ship together…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ship together' });
  await expect(dialog.getByRole('button', { name: 'Create 1 label for 3 orders' })).toBeVisible();
  await dialog.getByRole('checkbox').first().uncheck();
  await expect(dialog.getByRole('button', { name: 'Create 1 label for 2 orders' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Remove from group' }).last().click();
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText(/removed from the group/).first()).toBeVisible();
  await expect(dialog.getByRole('checkbox')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^Same buyer, 2 orders/ })).toBeVisible();
});

// T-0306 client changes: axe on every changed screen, and the new controls by keyboard.
const changed = [
  {
    name: 'orders with a same-buyer group',
    path: '/orders?placed=today&channel=ca_3',
    ready: 'Placed: Today',
  },
  { name: 'shipping desk with a group', path: '/shipping', ready: 'Pick orders to ship' },
  { name: 'order detail with the Same buyer panel', path: '/orders/ord_0495', ready: 'Same buyer' },
  { name: 'Amazon messages', path: '/customer-service?section=amazon', ready: 'Send reply' },
  {
    name: 'SKU detail on manual allocation',
    path: '/stock/0c0a1e9d-0000-4000-8000-000000000001',
    ready: 'Stock by channel',
  },
] as const;

for (const s of changed) {
  test(`[NFR-8] ${s.name} has no serious accessibility issues and works with the keyboard`, async ({
    page,
  }) => {
    await open(page, s.path, s.ready);
    await expectNoSeriousA11yIssues(page);
    await walkWithKeyboard(page);
  });
}

test('[HOME-3] the Orders today quick view opens with Enter and closes with Esc', async ({
  page,
}) => {
  await open(page, '/', 'Needs action');
  const chevron = page.getByRole('button', { name: "Show today's eBay orders" });
  await chevron.focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: "Today's eBay orders" });
  await expect(panel.getByText(/View all/)).toBeVisible();
  await expect(page.getByRole('button', { name: "Hide today's eBay orders" })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expectNoSeriousA11yIssues(page);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.getByRole('button', { name: "Show today's eBay orders" })).toBeFocused();
});

test('[ORD-9] a same-buyer group is reachable and usable by keyboard', async ({ page }) => {
  await open(page, '/orders?placed=today&channel=ca_3', 'Placed: Today');
  const chip = page.getByRole('button', { name: /^Same buyer, 3 orders/ });
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Ship together…' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(chip).toBeFocused();
  // Each member keeps its own checkbox and is labelled as part of the group.
  await expect(page.getByText(/order 2 of 3$/)).toBeVisible();
  await expect(page.getByText(/order 3 of 3$/)).toBeVisible();
  for (const row of await page
    .getByRole('row')
    .filter({ hasText: /Same buyer|of 3/ })
    .all())
    await expect(row.getByRole('checkbox')).toHaveCount(1);
});

// The manual allocation flows moved to stock.spec.ts with the real M09 routes (T-0317).

test('[PRF-6] order profit: profit inc VAT is profit ex VAT plus net VAT', async ({ page }) => {
  await open(page, '/orders/ord_0039', 'Ship to');
  const table = page.getByRole('table', { name: 'Profit on this order' });
  const profit = table.getByRole('row', { name: /^Profit/ });
  await expect(profit).toContainText('£13.43');
  await expect(profit).toContainText('£2.70');
  await expect(profit).toContainText('£16.13');
});

test('[WEB-1] with the website connector off, no area shows the Website channel', async ({
  page,
}) => {
  await open(page, '/', 'Needs action');
  await expect(page.locator('main')).toContainText('Website');
  await page.getByRole('button', { name: /Sam Admin/ }).click();
  await page.getByRole('menuitemradio', { name: /Robin Admin/ }).click();
  // Client-side navigation keeps the persona (a full reload resets the mock to the admin).
  const go = async (path: string, ready: string) => {
    await page.evaluate((p) => {
      history.pushState({}, '', p);
      dispatchEvent(new PopStateEvent('popstate'));
    }, path);
    await expect(page.getByText(ready).first()).toBeVisible();
    await expect(page.locator('main')).not.toContainText(/website|harbourgoods/i);
  };
  await go('/', 'Needs action');
  await go('/connections', 'Sales channels');
  await go('/orders', 'Awaiting dispatch');
  await page.getByRole('button', { name: 'Channel' }).click();
  await expect(page.getByRole('menuitemcheckbox')).toHaveCount(4);
  await expect(page.getByRole('menuitemcheckbox', { name: /harbourgoods/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await go('/stock', 'Stock');
  await go('/stock/listings', 'Not mapped');
  await go('/sales-profit', 'Sales & Profit');
  await go('/shipping', 'Shipping');
  await expect(page.locator('option[value="website"]')).toHaveCount(0);
});
