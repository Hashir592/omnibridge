// Client preview screenshots (T-0305). Not a test and not part of the gate (ADR-046 is unchanged):
// it saves one PNG per screen, in click-through order, for Hashir to send to the client.
// Start the dev server first (`corepack pnpm --dir apps/ui dev`), then from the repo root:
//   node apps/ui/scripts/client-preview.mjs docs/design/client-preview/<YYYYMMDD> [all|changes]
// "all" (default) is the T-0305 set of every screen; "changes" is the T-0306 set of the client's
// seven changes (C1 to C7).
// The folder is an argument, not a default: code that names a docs path would need the full gate
// on every docs-only change (tests/config/ci.test.ts).
// Synthetic mock data only; the clock is fixed so every relative date is the same on each run.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const BASE = process.env.UI_URL ?? 'http://localhost:5173';
const OUT = process.argv[2];
if (!OUT) {
  console.error('Usage: node apps/ui/scripts/client-preview.mjs <output folder>');
  process.exit(1);
}
const SET = process.argv[3] ?? 'all';
const NOW = new Date(SET === 'changes' ? '2026-11-12T10:00:00Z' : '2026-10-21T10:00:00Z');
const DESKTOP = { width: 1440, height: 900 };
const TABLET = { width: 820, height: 1180 };

const show = (locator) => locator.first().scrollIntoViewIfNeeded();

/** T-0306: the client's seven changes, in click-through order. */
const CHANGES = [
  [
    '01-home-orders-today-quick-view',
    '/',
    'Needs action',
    DESKTOP,
    async (page) => {
      await page.getByRole('button', { name: "Show today's eBay orders" }).click();
      await page
        .getByRole('region', { name: "Today's eBay orders" })
        .getByText(/View all/)
        .waitFor();
      await show(page.getByRole('region', { name: "Today's eBay orders" }));
    },
  ],
  [
    '02-orders-sku-column-and-same-buyer-group',
    '/orders?placed=today&channel=ca_3',
    'Placed: Today',
  ],
  [
    '03-orders-same-buyer-menu',
    '/orders?placed=today&channel=ca_3',
    'Placed: Today',
    DESKTOP,
    async (page) => {
      await page.getByRole('button', { name: /^Same buyer, 3 orders/ }).click();
      await page.getByRole('menuitem', { name: 'Ship together…' }).waitFor();
    },
  ],
  ['04-orders-related-order-not-shown', '/orders?view=today', 'related orders not shown'],
  [
    '05-ship-together-dialog',
    '/orders?placed=today&channel=ca_3',
    'Placed: Today',
    DESKTOP,
    async (page) => {
      await page.getByRole('button', { name: /^Same buyer, 3 orders/ }).click();
      await page.getByRole('menuitem', { name: 'Ship together…' }).click();
      await page.getByText('Create 1 label').waitFor();
      await page.getByText('Weight', { exact: true }).waitFor();
    },
  ],
  [
    '06-not-the-same-buyer-dialog',
    '/orders?placed=today&channel=ca_3',
    'Placed: Today',
    DESKTOP,
    async (page) => {
      await page.getByRole('button', { name: /^Same buyer, 3 orders/ }).click();
      await page.getByRole('menuitem', { name: 'Not the same buyer…' }).click();
      await page.getByRole('button', { name: 'Dismiss group' }).waitFor();
    },
  ],
  [
    '07-shipping-desk-same-buyer-group',
    '/shipping',
    'Pick orders to ship',
    DESKTOP,
    async (page) => {
      await show(page.getByRole('button', { name: /^Same buyer, 3 orders/ }));
    },
  ],
  ['08-order-detail-same-buyer-panel', '/orders/ord_0495', 'Same buyer'],
  [
    '09-order-detail-profit-ex-and-inc-vat',
    '/orders/ord_0039',
    'Ship to',
    DESKTOP,
    async (page) => {
      await show(page.getByRole('table', { name: 'Profit on this order' }));
    },
  ],
  [
    '10-account-health-amazon-seller-feedback',
    '/account-health',
    'Order Defect Rate',
    DESKTOP,
    async (page) => {
      await show(page.getByRole('heading', { name: 'Seller feedback' }));
    },
  ],
  [
    '11-account-health-recovery-estimate',
    '/account-health',
    'Order Defect Rate',
    DESKTOP,
    async (page) => {
      await show(page.getByText(/late shipments leave/));
    },
  ],
  ['12-customer-service-amazon-messages', '/customer-service?section=amazon', 'Send reply'],
  [
    '13-connections-amazon-buyer-messages-setup',
    '/connections',
    'Sales channels',
    DESKTOP,
    async (page) => {
      await show(page.getByRole('region', { name: 'Buyer messages setup' }));
    },
  ],
  ['14-stock-list-manual-and-mixed', '/stock', 'of 200 SKUs'],
  [
    '15-sku-detail-manual-allocation',
    '/stock/sku_0',
    'Stock by channel',
    DESKTOP,
    async (page) => {
      await show(page.getByText(/^Allocated /));
    },
  ],
  [
    '16-sku-detail-back-to-auto-results',
    '/stock/sku_0',
    'Stock by channel',
    DESKTOP,
    async (page) => {
      await page.getByRole('radio', { name: 'Auto' }).click();
      await page.getByRole('button', { name: 'Switch to Auto' }).click();
      await show(page.getByText('Back on Auto: every listing was pushed'));
    },
  ],
];

/** [file name, path, text that shows the page is ready, viewport, optional step before the shot] */
const ALL = [
  ['01-sign-in', '/sign-in', 'Sign in'],
  ['02-home', '/', 'Needs action'],
  ['03-orders', '/orders', 'of 500 orders'],
  ['04-order-detail', '/orders/ord_0039', 'Ship to'],
  ['05-shipping-desk', '/shipping', 'Pick orders to ship'],
  ['06-stock-list', '/stock', 'of 200 SKUs'],
  ['07-stock-list-tablet', '/stock', 'of 200 SKUs', TABLET],
  ['08-stock-unmapped-listings', '/stock?view=unmapped', 'Suggested match'],
  ['09-sku-detail', '/stock/sku_3', 'Stock by channel'],
  ['10-sku-detail-tablet', '/stock/sku_3', 'Stock by channel', TABLET],
  ['11-sales-profit', '/sales-profit', 'How contribution profit is made'],
  ['12-finance-vat-quarter', '/finance', 'VAT payable'],
  ['13-finance-expenses', '/finance?section=expenses', 'Invoice date'],
  ['14-finance-profit-and-loss', '/finance?section=pnl', 'Gross profit'],
  ['15-account-health-amazon', '/account-health', 'Order Defect Rate'],
  ['16-account-health-ebay', '/account-health?market=ebay', 'Transaction defect rate'],
  ['17-users', '/users', 'Two-step sign-in'],
  ['18-user-tabs-and-companies', '/users/usr_5', 'Tabs this user can see'],
  ['19-connections', '/connections', 'Sales channels'],
  ['20-customer-service-messages', '/customer-service', 'Send reply'],
  ['21-customer-service-feedback', '/customer-service?section=feedback', 'Latest eBay feedback'],
  ['22-amazon-review-requests', '/customer-service?section=reviews', 'Daily review requests'],
  ['23-advertising-campaigns', '/advertising', 'Budget / day'],
  ['24-advertising-rules', '/advertising?section=rules', 'Safety caps'],
  ['25-negative-keyword-finder', '/advertising?section=negatives', 'Search term'],
  ['26-forecasting', '/forecasting', 'Suggested order'],
  ['27-reminders', '/reminders', 'Coming up'],
  ['28-notes', '/notes', 'Save note'],
  [
    '29-notifications',
    '/',
    'Needs action',
    DESKTOP,
    async (page) => {
      await page.getByRole('button', { name: /^Notifications,/ }).click();
      await page.getByText('Mark all read').waitFor();
    },
  ],
  ['30-audit-log', '/audit-log', 'Before → after'],
  ['31-settings-workspace', '/settings', 'Customer details kept'],
  ['32-settings-notifications', '/settings?section=notifications', 'Always on for admins'],
  ['33-settings-my-account', '/settings?section=security', 'Where you are signed in'],
  ['34-password-change', '/sign-in/password-change', 'Current password'],
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [name, path, ready, viewport = DESKTOP, before] of SET === 'changes' ? CHANGES : ALL) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    await page.clock.setFixedTime(NOW);
    await page.goto(BASE + path);
    await page.getByText(ready).first().waitFor({ timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    if (before) await before(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    await page.close();
    console.log(`saved ${name}.png`);
  }
} finally {
  await browser.close();
}
