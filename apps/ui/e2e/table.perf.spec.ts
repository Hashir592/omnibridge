import { expect, test } from '@playwright/test';

// T-0302 acceptance: the table renders 10,000 rows with smooth scroll, under 16 ms per frame.
// Runs in the "ui-perf" project against a production build (see playwright.config.ts).
//
// What is measured, from Chrome's own performance counters over 120 animation frames while the
// table scrolls ten rows per frame:
// - the work the table causes on the main thread (script + style + layout) must stay under 16 ms
//   a frame. Painting is left out: headless Chromium paints in software, so paint time measures
//   the test machine, not the app;
// - the median frame gap must stay at 60 fps, i.e. scrolling never falls behind the display.
test('[NFR-8] the table scrolls 10,000 rows within the 16 ms frame budget', async ({ page }) => {
  await page.goto('/__ui');
  const table = page.getByRole('table', { name: 'Ten thousand products' });
  await table.scrollIntoViewIfNeeded();
  await expect(table.getByText('SKU-10000')).toBeVisible();

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const counters = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const get = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
    return get('ScriptDuration') + get('RecalcStyleDuration') + get('LayoutDuration');
  };

  const frames = 120;
  const before = await counters();
  const gaps = await table.evaluate(
    (el, n) =>
      new Promise<number[]>((resolve) => {
        const out: number[] = [];
        let last = performance.now();
        const step = (t: number) => {
          out.push(t - last);
          last = t;
          el.scrollTop += 560; // ten 56 px rows per frame: fast scrolling
          if (out.length < n) requestAnimationFrame(step);
          else resolve(out.slice(1));
        };
        requestAnimationFrame(step);
      }),
    frames,
  );
  const after = await counters();

  const workPerFrame = ((after - before) * 1000) / frames;
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? Infinity;
  test.info().annotations.push({
    type: 'perf',
    description: `table work ${workPerFrame.toFixed(2)} ms per frame; median frame gap ${median.toFixed(1)} ms`,
  });

  expect(workPerFrame).toBeLessThan(16);
  expect(median).toBeLessThan(17.5);
  // The virtualiser keeps the DOM small however far the table scrolls.
  expect(await table.getByRole('row').count()).toBeLessThan(60);
  expect(await table.evaluate((el) => el.scrollTop)).toBeGreaterThan(60_000);
});
