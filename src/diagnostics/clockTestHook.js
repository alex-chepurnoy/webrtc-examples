/*
 * A simulated remote clock and injected one-way delays, for the end-to-end tests only.
 *
 * Two pages in one browser context share an operating system clock, so the true offset between
 * them is zero and nothing about the clock estimator can be checked against a known truth. This
 * hook lets a test make it nonzero and known: window.__wzClockTest = { skewMs, forwardDelayMs,
 * reverseDelayMs }, set from an init script or later from page.evaluate.
 *
 *   skewMs          added to every Date.now() reading this page takes as part of the probe: the
 *                   frame stamp it writes, the arrival time of a frame it reads, and the four
 *                   timestamps of the clock exchange. A page with skewMs 5000 behaves like a
 *                   machine whose clock runs 5 s ahead, so the true offset to a page without it
 *                   is exactly that.
 *   forwardDelayMs  held back from a clock ping AFTER its t0 is taken, so it is path delay in
 *                   the forward direction that the estimator has to be right about.
 *   reverseDelayMs  the same for the reply, held back after t2 is taken.
 *
 * Gated on the build mode, as the reconnect timings are: a production build folds the constant
 * and none of this is reachable, which the end-to-end suite builds in the e2e mode to use. The
 * skew moves only the probe's own readings. It is not applied to the stall check, which
 * compares the arrival time with the real clock, so put it on the page that plays the far end.
 */

export const CLOCK_TEST_HOOK = import.meta.env.MODE !== 'production';

const setting = (key) => {
  if (!CLOCK_TEST_HOOK || typeof window === 'undefined') return 0;
  const value = window.__wzClockTest?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

/** The skew in effect on this page, 0 outside a test. */
export const testSkewMs = () => setting('skewMs');

/** Delay to hold a clock ping back by, after t0 was taken. 0 outside a test. */
export const testForwardDelayMs = () => setting('forwardDelayMs');

/** Delay to hold a clock reply back by, after t2 was taken. 0 outside a test. */
export const testReverseDelayMs = () => setting('reverseDelayMs');

/** Date.now() as this page's probe reads it: the real clock plus the test skew. */
export const clockNow = () => Date.now() + testSkewMs();

/**
 * Sends now, or after `delayMs`. The immediate path is the production path exactly, so a send
 * that throws still throws to the caller; a delayed one cannot, and reports through `onError`.
 */
export const sendAfter = (send, delayMs, onError) => {
  if (!CLOCK_TEST_HOOK || !(delayMs > 0)) {
    send();
    return;
  }
  window.setTimeout(() => {
    try {
      send();
    } catch (error) {
      onError?.(error);
    }
  }, delayMs);
};

/**
 * Announces, on the page, that a build with this hook is running, and exposes the clock
 * descriptor to the test. A preview server left over from an older build has neither, and the
 * test says so instead of passing against a clock nobody moved.
 */
export const exposeForTests = (readClock) => {
  if (!CLOCK_TEST_HOOK || typeof window === 'undefined') return;
  window.__wzClockTestLive = true;
  window.__wzClockProbe = readClock;
};
