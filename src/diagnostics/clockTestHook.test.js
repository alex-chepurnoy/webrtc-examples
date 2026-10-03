import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CLOCK_TEST_HOOK,
  clockNow,
  exposeForTests,
  sendAfter,
  testForwardDelayMs,
  testReverseDelayMs,
  testSkewMs,
} from './clockTestHook';

afterEach(() => {
  delete window.__wzClockTest;
  delete window.__wzClockTestLive;
  delete window.__wzClockProbe;
  vi.useRealTimers();
});

describe('the clock test hook', () => {
  it('is active outside a production build, which is how the tests run', () => {
    expect(CLOCK_TEST_HOOK).toBe(true);
  });

  it('adds nothing when no test has set it', () => {
    expect(testSkewMs()).toBe(0);
    expect(testForwardDelayMs()).toBe(0);
    expect(testReverseDelayMs()).toBe(0);
    expect(Math.abs(clockNow() - Date.now())).toBeLessThan(5);
  });

  it('skews the clock by the number a test set, and follows a change', () => {
    window.__wzClockTest = { skewMs: 5000 };
    expect(clockNow() - Date.now()).toBeGreaterThanOrEqual(5000);
    window.__wzClockTest.skewMs = -2000;
    expect(clockNow() - Date.now()).toBeLessThanOrEqual(-1990);
  });

  it('ignores a setting that is not a finite number', () => {
    window.__wzClockTest = { skewMs: '5000', forwardDelayMs: Number.NaN };
    expect(testSkewMs()).toBe(0);
    expect(testForwardDelayMs()).toBe(0);
  });

  it('sends at once with no delay and later with one', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    sendAfter(send, 0);
    expect(send).toHaveBeenCalledTimes(1);
    sendAfter(send, 60);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('lets an immediate send throw to its caller and reports a delayed one', () => {
    vi.useFakeTimers();
    const boom = () => { throw new Error('closed'); };
    expect(() => sendAfter(boom, 0)).toThrow('closed');
    const onError = vi.fn();
    sendAfter(boom, 10, onError);
    vi.advanceTimersByTime(10);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('marks the page and exposes the descriptor reader', () => {
    exposeForTests(() => 'clock');
    expect(window.__wzClockTestLive).toBe(true);
    expect(window.__wzClockProbe()).toBe('clock');
  });
});
