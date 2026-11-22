import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// T-0313 platform console on the MSW mock, which follows the T-0504 and T-0505 routes (PS-032,
// PS-033). No screenshot tests (ADR-046): axe, the gate and the flows. In the mock-ups the demo
// admin is a platform operator and the packer is not.
const NOW = new Date('2026-11-20T10:00:00Z');
const SECRET = 'synthetic-demo-secret-value-0001';

async function openConsole(page: Page, section?: string): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto(section ? `/platform?section=${section}` : '/platform');
  await page.getByRole('button', { name: 'Open the console' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Platform console' })).toBeVisible();
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

const SECTIONS = [
  { tab: 'Workspaces', table: 'Workspaces' },
  { tab: 'Jobs', table: 'Dead letters' },
  { tab: 'API usage', table: 'API usage' },
  { tab: 'Credentials', table: 'Credential calendar' },
  { tab: 'App secrets', table: 'App secrets' },
] as const;

test('[PLAT-1] [NFR-8] every console section has no serious accessibility issues', async ({
  page,
}) => {
  await openConsole(page);
  for (const s of SECTIONS) {
    await page.getByRole('tab', { name: s.tab }).click();
    await expect(page.getByRole('table', { name: s.table })).toBeVisible();
    await expectNoSeriousA11yIssues(page);
  }
  for (const tab of ['Health', 'Incident banner', 'Maintenance', 'Flags']) {
    await page.getByRole('tab', { name: tab }).click();
    // By name: while a tab changes, the panel leaving is still in the page for a moment.
    await expect(page.getByRole('tabpanel', { name: tab })).not.toContainText('Loading');
    await expectNoSeriousA11yIssues(page);
  }
});

test('[PLAT-1] the console is not linked from the app, and a non-operator is refused', async ({
  page,
}) => {
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await expect(page.locator('a[href^="/platform"]')).toHaveCount(0);
  // Become the packer (the mock resets on a full load, so stay in the page), then go to /platform.
  await page.getByRole('button', { name: /Sam Admin/ }).click();
  await page.getByRole('menuitemradio', { name: /Pat Packer/ }).click();
  await page.evaluate(() => {
    history.pushState({}, '', '/platform');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.getByRole('button', { name: 'Open the console' }).click();
  await expect(page.getByRole('alert')).toContainText('not open to this account');
  await expect(page.getByRole('heading', { level: 1, name: 'Platform console' })).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'Workspaces' })).toHaveCount(0);
});

test('[PLAT-2] status moves ask first; archive is final; counts only', async ({ page }) => {
  await openConsole(page);
  const table = page.getByRole('table', { name: 'Workspaces' });
  const demo = table.getByRole('row', { name: /Demo workspace/ }).first();
  await expect(demo).toContainText('Not yet'); // orders per day is null until M10
  await expect(table.getByRole('row', { name: /Closed workspace/ })).toContainText('Final');

  await page.getByRole('button', { name: 'Suspend Demo workspace' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('signed out');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(demo).toContainText('Active');

  await page.getByRole('button', { name: 'Reactivate Trial workspace' }).click();
  await page.getByRole('button', { name: 'Reactivate Trial workspace' }).last().click();
  await expect(table.getByRole('row', { name: /Trial workspace/ })).toContainText('Active');

  await page.getByRole('button', { name: 'Archive Second demo workspace' }).click();
  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText('cannot be undone');
  await expect(ask).toContainText('every member is removed');
  await ask.getByRole('button', { name: 'Archive Second demo workspace' }).click();
  const second = table.getByRole('row', { name: /Second demo workspace/ });
  await expect(second).toContainText('Archived');
  await expect(second).toContainText('Final');
  await expect(second.getByRole('checkbox')).toBeDisabled();
});

test('[PLAT-2] a dead letter is redriven after asking', async ({ page }) => {
  await openConsole(page, 'jobs');
  const dead = page.getByRole('table', { name: 'Dead letters' });
  await expect(dead.getByRole('row')).toHaveCount(3);
  await page.getByRole('button', { name: /^Redrive notify\.email job/ }).click();
  await page.getByRole('button', { name: 'Redrive job' }).click();
  await expect(dead.getByRole('row')).toHaveCount(2);
  await expect(dead).not.toContainText('notify.email');
});

test('[PLAT-2] the incident banner is checked, shown as a plain line and cleared', async ({
  page,
}) => {
  await openConsole(page, 'incident');
  await expect(page.getByText('No banner. Nobody sees one.')).toBeVisible();
  const message = page.getByRole('textbox', { name: 'Message' });
  await message.fill('Write to ops@example.test');
  await page.getByRole('button', { name: 'Show banner' }).click();
  await expect(page.getByText('Leave out email addresses.')).toBeVisible();

  await message.fill('eBay orders are arriving late. We are on it.');
  await page.getByRole('button', { name: 'Show banner' }).click();
  // The console's own line comes from GET /auth/session, as in the app.
  const line = page.getByRole('status').filter({ hasText: 'eBay orders are arriving late' });
  await expect(line.first()).toBeVisible();
  await expect(message).toHaveValue('');

  await page.getByRole('button', { name: 'Clear banner' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Clear banner' }).click();
  await expect(page.getByText('No banner. Nobody sees one.')).toBeVisible();
});

test('[PLAT-4] app secrets are write-only: set-on dates only, field never prefilled', async ({
  page,
}) => {
  await openConsole(page, 'secrets');
  const table = page.getByRole('table', { name: 'App secrets' });
  const ebay = table.getByRole('row', { name: /eBay client ID/ });
  await expect(ebay).toContainText('Not set');
  // Promote shows only where a next value exists.
  await expect(page.getByRole('button', { name: /^Promote the next value of eBay/ })).toHaveCount(
    0,
  );

  await page
    .getByRole('button', { name: 'Set the current value of eBay client ID (App ID)' })
    .click();
  const field = page.getByRole('dialog').getByLabel('Value');
  await expect(field).toHaveValue('');
  await expect(field).toHaveAttribute('type', 'password');
  await field.fill(SECRET);
  await page.getByRole('button', { name: 'Save value' }).click();
  await expect(page.getByRole('dialog', { name: 'Set the current value' })).toHaveCount(0);
  await expect(ebay).toContainText('Set 20/11/2026');
  await expect(page.locator('body')).not.toContainText(SECRET);

  // Opening the form again starts empty: nothing is kept or echoed.
  await page
    .getByRole('button', { name: 'Set the current value of eBay client ID (App ID)' })
    .click();
  await expect(page.getByRole('dialog').getByLabel('Value')).toHaveValue('');
  await page.getByRole('button', { name: 'Cancel' }).click();

  const lwa = table.getByRole('row', { name: /Amazon LWA client secret/ });
  await page
    .getByRole('button', { name: 'Promote the next value of Amazon LWA client secret' })
    .click();
  await page.getByRole('button', { name: 'Promote next value' }).click();
  await expect(lwa.getByRole('cell').nth(2)).toContainText('Not set');
});

test('[PLAT-2] [PLAT-4] the credential calendar lists app secrets as the platform', async ({
  page,
}) => {
  await openConsole(page, 'credentials');
  const table = page.getByRole('table', { name: 'Credential calendar' });
  const lwa = table.getByRole('row', { name: /Amazon LWA client secret/ });
  await expect(lwa).toContainText('Platform');
  await expect(lwa).toContainText('App secret');
  await expect(table.getByRole('row', { name: /eBay refresh token/ })).toContainText(
    'Demo workspace',
  );
});
