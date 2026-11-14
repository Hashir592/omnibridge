// Client preview screenshots (T-0305). Not a test and not part of the gate (ADR-046 is unchanged):
// it saves one PNG per screen, in click-through order, for Hashir to send to the client.
// Start the dev server first (`corepack pnpm --dir apps/ui dev`), then from the repo root:
//   node apps/ui/scripts/client-preview.mjs [output folder]
// Synthetic mock data only; the clock is fixed so every relative date is the same on each run.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const BASE = process.env.UI_URL ?? 'http://localhost:5173';
const OUT = process.argv[2] ?? 'docs/design/client-preview/20261021';
const NOW = new Date('2026-10-21T10:00:00Z');
const DESKTOP = { width: 1440, height: 900 };
const TABLET = { width: 820, height: 1180 };

/** [file name, path, text that shows the page is ready, viewport, optional step before the shot] */
const SHOTS = [
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
  for (const [name, path, ready, viewport = DESKTOP, before] of SHOTS) {
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
