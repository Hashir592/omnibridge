import { expect, test } from '@playwright/test';

// T-0302 acceptance: the table renders 10,000 rows with smooth scroll, under 16 ms per frame.
// Runs in the "ui-perf" project against a production build (see playwright.config.ts).
//
// What is measured (ADR-046, ruled after CI run 39421307043), from Chrome's own performance
// counters while the table scrolls ten rows per frame:
// - HARD CHECK: the main-thread work the table causes (script + style + layout) per frame. It is
//   sampled over windows of 10 frames, 12 windows per run, 3 runs; the p95 of those 36 samples
//   must stay under 16 ms. Painting is left out: headless Chromium paints in software, so paint
//   time measures the test machine, not the app.
// - WARNING ONLY: the median gap between animation frames. Shared CI runners throttle headless
//   Chromium to 30 fps (33.3 ms gaps) however little work a frame does, so the gap is logged and
//   annotated, never failed. The 16 ms budget itself never changes.
const RUNS = 3;
const WINDOWS = 12;
const FRAMES = 10;

test('[NFR-8] the table scrolls 10,000 rows within the 16 ms frame budget', async ({ page }) => {
  test.setTimeout(90_000);
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
  // Scrolls `n` frames, ten 56 px rows per frame (fast scrolling); returns the frame gaps.
  const scrollFrames = (n: number) =>
    table.evaluate(
      (el, args) =>
        new Promise<number[]>((resolve) => {
          const out: number[] = [];
          let last = performance.now();
          const step = (t: number) => {
            out.push(t - last);
            last = t;
            el.scrollTop += args.step;
            if (out.length < args.count + 1) requestAnimationFrame(step);
            else resolve(out.slice(1));
          };
          requestAnimationFrame(step);
        }),
      { count: n, step: 560 },
    );

  const work: number[] = [];
  const gaps: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    await table.evaluate((el) => {
      el.scrollTop = 0;
    });
    await scrollFrames(2); // settle after the jump back to the top
    for (let w = 0; w < WINDOWS; w++) {
      const before = await counters();
      gaps.push(...(await scrollFrames(FRAMES)));
      const after = await counters();
      work.push(((after - before) * 1000) / FRAMES);
    }
  }

  const pct = (xs: number[], p: number) => {
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? Infinity;
  };
  const workP95 = pct(work, 0.95);
  const gapMedian = pct(gaps, 0.5);
  const summary = `table work p95 ${workP95.toFixed(2)} ms per frame (${String(work.length)} samples, ${String(RUNS)} runs); median frame gap ${gapMedian.toFixed(1)} ms`;
  test.info().annotations.push({ type: 'perf', description: summary });
  // Also on stdout, so the CI log shows the numbers on a pass, not only in the HTML report.
  console.log(`[ui-perf] ${summary}`);
  if (gapMedian >= 17.5) {
    const msg = `median frame gap ${gapMedian.toFixed(1)} ms is above 60 fps; the runner is throttling frames (warning only, ADR-046)`;
    test.info().annotations.push({ type: 'warning', description: msg });
    console.warn(`[ui-perf] ${msg}`);
  }

  expect(workP95).toBeLessThan(16);
  // The virtualiser keeps the DOM small however far the table scrolls.
  expect(await table.getByRole('row').count()).toBeLessThan(60);
  expect(await table.evaluate((el) => el.scrollTop)).toBeGreaterThan(60_000);
});
