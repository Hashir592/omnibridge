import { expect, test } from '@playwright/test';

// The public site (T-0601, PRD §10.2) through the HTTPS edge, as Amazon and eBay reviewers see it.
const siteUrl = process.env.OB_SITE_URL ?? 'https://localhost:8444';
const PAGES = [
  '/',
  '/features',
  '/amazon',
  '/ebay',
  '/security',
  '/privacy',
  '/terms',
  '/cookies',
  '/contact',
];

test('[WWW-4] every page loads with no login wall and no "under construction" text', async ({
  page,
}) => {
  for (const path of PAGES) {
    const res = await page.goto(siteUrl + path);
    expect({ path, status: res?.status() }).toEqual({ path, status: 200 });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const text = (await page.locator('body').innerText()).toLowerCase();
    for (const banned of ['under construction', 'coming soon', 'lorem ipsum']) {
      expect({ path, banned, found: text.includes(banned) }).toEqual({
        path,
        banned,
        found: false,
      });
    }
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  }
});

test('[WWW-3] no third-party script, request or cookie on any page', async ({ page, context }) => {
  const origin = new URL(siteUrl).origin;
  const outside: string[] = [];
  page.on('request', (req) => {
    if (!req.url().startsWith(origin) && !req.url().startsWith('data:')) outside.push(req.url());
  });
  for (const path of PAGES) {
    await page.goto(siteUrl + path, { waitUntil: 'networkidle' });
    expect({ path, scripts: await page.locator('script').count() }).toEqual({ path, scripts: 0 });
  }
  expect(outside).toEqual([]);
  expect(await context.cookies()).toEqual([]);
});

test('[WWW-2] every footer names the Operator from settings', async ({ page }) => {
  for (const path of PAGES) {
    await page.goto(siteUrl + path);
    await expect(page.locator('footer')).toContainText(
      /OmniBridge is operated by .+, company number .+, registered office .+\./,
    );
  }
});

test('[WWW-1] the logo is in the header and the favicon on every page', async ({
  page,
  request,
}) => {
  for (const path of PAGES) {
    await page.goto(siteUrl + path);
    await expect(page.locator('header img[alt="OmniBridge"]')).toBeVisible();
    await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute('href', '/favicon.ico');
  }
  expect((await request.get(`${siteUrl}/favicon.ico`)).status()).toBe(200);
});

test('[WWW-3] every response carries the security headers', async ({ request }) => {
  const res = await request.get(siteUrl);
  const headers = res.headers();
  expect(headers['content-security-policy']).toContain("default-src 'none'");
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
});

test('[DP-1][DP-2][DP-3] the privacy policy names the controllers, processors and sub-processors', async ({
  page,
}) => {
  await page.goto(`${siteUrl}/privacy`);
  const text = await page.locator('main').innerText();
  for (const phrase of [
    'controller',
    'processor',
    'independent controller',
    'netcup',
    'Scaleway',
    'Zoho',
    'Evri and DPD',
    'Pakistan',
    'International Data Transfer Agreement',
    '30 days of delivery',
    'Information Commissioner',
    'privacy@omnibridge.co.uk',
  ]) {
    expect({ phrase, found: text.includes(phrase) }).toEqual({ phrase, found: true });
  }
});
