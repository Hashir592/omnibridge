import { expect, test } from '@playwright/test';

const siteUrl = process.env.OB_SITE_URL ?? 'https://localhost:8444';

test('[NFR-1] the public site loads over HTTPS', async ({ page }) => {
  await page.goto(siteUrl);
  await expect(page).toHaveTitle('OmniBridge');
  await expect(page.getByRole('img', { name: 'OmniBridge', exact: true })).toBeVisible();
});

test('[NFR-2] /healthz reports db_main and db_pii ok through the edge', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ status: 'ok', db_main: 'ok', db_pii: 'ok' });
});
