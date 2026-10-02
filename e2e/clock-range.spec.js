import { test, expect } from '@playwright/test';
import { requireEngine, uniqueStream } from './helpers.js';
import {
  expectLive,
  expectPlaying,
  openTab,
  startPlaying,
  startPublishing,
  waitForCamera,
} from './ui-helpers.js';

/*
 * The clock range against a KNOWN truth, with no second machine.
 *
 * Two pages in one browser context read one operating system clock, so the real offset between
 * them is zero. The test-only hook (src/diagnostics/clockTestHook.js, honored only outside a
 * production build) makes a page's probe behave like a machine whose clock is skewMs ahead, so
 * the true offset becomes exactly that number, and holds clock pings and replies back to make
 * one direction slow. The assertions compare the descriptor's offset with the injected skew
 * directly. They do not compare with a reference run, because a reference carries the Engine's
 * own path asymmetry.
 *
 * The bound is a guarantee, not a statistic, so containment is asserted on every read.
 *
 * Needs a build with the hook: Playwright's webServer builds with --mode e2e. A server left
 * over from an older build has no hook, and the first test says so rather than passing against
 * a clock nobody moved.
 */

const RUN = { setup: 90_000, settle: 20_000, step: 25_000 };

const installHook = (initial) => { window.__wzClockTest = initial; };

/** Publisher on /publish, viewer on /play, each with the probe on and its own hook settings. */
const openPair = async (browser, { publisher: pubHook = {}, viewer: viewHook = {} } = {}) => {
  const context = await browser.newContext();
  const publisher = await context.newPage();
  const viewer = await context.newPage();
  await publisher.addInitScript(installHook, pubHook);
  await viewer.addInitScript(installHook, viewHook);

  await publisher.goto('/#/publish');
  await requireEngine(publisher, test);

  const streamName = uniqueStream('clk');
  await waitForCamera(publisher);
  await openTab(publisher, 'Advanced');
  await publisher.locator('#publishLatencyProbe').check();
  await openTab(publisher, 'Connection');
  await startPublishing(publisher, { streamName });
  await expectLive(publisher);

  await viewer.goto('/#/play');
  await openTab(viewer, 'Advanced');
  await viewer.locator('#playLatencyProbe').check();
  await openTab(viewer, 'Connection');
  await startPlaying(viewer, { streamName });
  await expectPlaying(viewer);

  return { context, publisher, viewer };
};

const readClock = (viewer) => viewer.evaluate(() => window.__wzClockProbe?.() ?? null);

/** Waits for a cross-machine range, and returns the descriptor. */
const untilRange = async (viewer, timeout = RUN.settle) => {
  let clock = null;
  await expect.poll(async () => {
    clock = await readClock(viewer);
    return clock?.state === 'ok' && clock.exact === false;
  }, { timeout, message: 'the clock never produced a cross-machine range' }).toBe(true);
  return clock;
};

/** The truth must be inside the stated bound, on every read for a few seconds. */
const expectContains = async (viewer, truth, { seconds = 4 } = {}) => {
  const misses = [];
  for (let i = 0; i < seconds * 2; i += 1) {
    const clock = await readClock(viewer);
    if (clock?.state === 'ok') {
      const error = clock.offsetMs - truth;
      if (Math.abs(error) > clock.uncertaintyMs) {
        misses.push(`error ${error.toFixed(1)} ms outside bound ${clock.uncertaintyMs.toFixed(1)} ms`);
      }
    }
    await viewer.waitForTimeout(500);
  }
  expect(misses, 'the true offset left the stated range').toEqual([]);
};

const expectNoRefusal = async (viewer) => {
  await expect(viewer.locator('#latency-group')).not.toContainText(/too uncertain/i);
  await expect(viewer.locator('#latency-group')).not.toContainText(/not stable enough/i);
};

test.describe('the clock range against an injected truth', () => {
  test.setTimeout(RUN.setup + RUN.settle + 30_000);

  test('the build carries the test hook (a stale server fails here, loudly)', async ({ browser }) => {
    const { context, publisher, viewer } = await openPair(browser);
    try {
      for (const page of [publisher, viewer]) {
        expect(await page.evaluate(() => window.__wzClockTestLive),
          'this server was built without the clock test hook; rebuild with --mode e2e').toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  test('no skew: the range contains zero, whatever the Engine path is', async ({ browser }) => {
    const { context, viewer } = await openPair(browser);
    try {
      // A local Engine can be close enough to read exact (one clock), which is also zero.
      await expect.poll(async () => (await readClock(viewer))?.state, { timeout: RUN.settle })
        .toBe('ok');
      await expectContains(viewer, 0);
      await expectNoRefusal(viewer);
    } finally {
      await context.close();
    }
  });

  test('a clock 5 s ahead is bounded, and the transport is not 5 s', async ({ browser }) => {
    const { context, viewer } = await openPair(browser, { publisher: { skewMs: 5000 } });
    try {
      const clock = await untilRange(viewer);
      expect(clock.mode).toBe('cross-machine');
      await expectContains(viewer, 5000);
      await expectNoRefusal(viewer);

      // The figure on screen is the stamp difference corrected by that offset: milliseconds,
      // where an uncorrected one would read 5 s.
      const row = viewer.locator('.wz-latency__table tr', { hasText: 'Publisher to player' });
      await expect(row).toContainText(/\d+\s*ms/);
      const numbers = [...(await row.innerText()).matchAll(/(\d+)\s*ms/g)].map((m) => Number(m[1]));
      expect(Math.min(...numbers), await row.innerText()).toBeLessThan(2500);
    } finally {
      await context.close();
    }
  });

  // 60 ms added to the forward direction only: the estimate moves by half (about +30) and the
  // range still holds the truth, which is the whole point of an interval over a midpoint.
  test('60 ms added forward moves the estimate about +30 ms, inside the range', async ({ browser }) => {
    const { context, viewer } = await openPair(browser, {
      publisher: { skewMs: 2000 },
      viewer: { forwardDelayMs: 60 },
    });
    try {
      await untilRange(viewer);
      await viewer.waitForTimeout(6000);
      const clock = await readClock(viewer);
      const error = clock.offsetMs - 2000;
      // 30 ms expected; the band leaves room for the real path's own asymmetry, and still
      // fails an estimator that ignores the delay (about 0) or doubles it (about 60).
      expect(error, `error ${error}`).toBeGreaterThan(10);
      expect(error, `error ${error}`).toBeLessThan(50);
      expect(clock.uncertaintyMs).toBeGreaterThan(Math.abs(error));
      await expectContains(viewer, 2000);
      await expectNoRefusal(viewer);
    } finally {
      await context.close();
    }
  });

  test('60 ms added in reverse moves the estimate about -30 ms, inside the range', async ({ browser }) => {
    const { context, viewer } = await openPair(browser, {
      publisher: { skewMs: 2000, reverseDelayMs: 60 },
    });
    try {
      await untilRange(viewer);
      await viewer.waitForTimeout(6000);
      const clock = await readClock(viewer);
      const error = clock.offsetMs - 2000;
      expect(error, `error ${error}`).toBeLessThan(-10);
      expect(error, `error ${error}`).toBeGreaterThan(-50);
      expect(clock.uncertaintyMs).toBeGreaterThan(Math.abs(error));
      await expectContains(viewer, 2000);
    } finally {
      await context.close();
    }
  });

  // The old design refused above about 58 ms of round trip. 500 ms is a wide range and an answer.
  test('a 500 ms round trip shows a wide range with its hint, not a refusal', async ({ browser }) => {
    const { context, viewer } = await openPair(browser, {
      publisher: { skewMs: 1500, reverseDelayMs: 250 },
      viewer: { forwardDelayMs: 250 },
    });
    try {
      const clock = await untilRange(viewer);
      expect(clock.wide).toBe(true);
      await expectContains(viewer, 1500);

      const group = viewer.locator('.wz-latency');
      await expect(group).toContainText('assuming stable clocks');
      await expect(group).toContainText('Wide because the path between the two ends is long or uneven');
      await expect(group.locator('.wz-latency__table tr', { hasText: 'Publisher to player' })).toContainText(/±|0 to/);
      await expectNoRefusal(viewer);
    } finally {
      await context.close();
    }
  });

  // The far clock steps 3 s mid-run. The old samples cannot all be right: flagged, dropped, and
  // the range comes back on the new offset within a few seconds.
  test('a clock step mid-run is flagged and the range recovers on the new offset', async ({ browser }) => {
    test.setTimeout(RUN.setup + RUN.step + 30_000);
    const { context, publisher, viewer } = await openPair(browser, { publisher: { skewMs: 0 } });
    try {
      // At skew 0 against a nearby Engine the clock may read exact (one clock); a range is not
      // required until the step.
      await expect.poll(async () => (await readClock(viewer))?.state, { timeout: RUN.settle })
        .toBe('ok');
      await viewer.waitForTimeout(6000);
      await expectContains(viewer, 0, { seconds: 2 });

      await publisher.evaluate(() => { window.__wzClockTest.skewMs = 3000; });

      let flagged = false;
      await expect.poll(async () => {
        const clock = await readClock(viewer);
        if (clock?.resyncing || clock?.stepAgeMs != null) flagged = true;
        return clock?.state === 'ok' && Math.abs(clock.offsetMs - 3000) <= clock.uncertaintyMs
          && clock.stepAgeMs != null;
      }, { timeout: RUN.step, message: 'the range did not recover on the stepped clock' }).toBe(true);
      expect(flagged, 'the step was never flagged').toBe(true);
      await expectContains(viewer, 3000, { seconds: 3 });
    } finally {
      await context.close();
    }
  });
});
