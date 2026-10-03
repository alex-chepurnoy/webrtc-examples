import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

// The probe is replaced by one sample per test; the panel computes nothing of its own.
const probe = vi.hoisted(() => ({ sample: null }));
vi.mock('../../diagnostics/latencyProbe', () => ({
  STALE_MS: 1000,
  EMIT_INTERVAL_MS: 500,
  latencyProbeSupport: () => ({ supported: true, reason: null }),
  subscribe: (fn) => {
    fn(probe.sample);
    return () => {};
  },
}));

import LatencyGroup from './LatencyGroup';

const store = () => configureStore({
  reducer: { playSettings: (state = { latencyProbe: true }) => state },
});

const sampleWith = (overrides = {}) => ({
  status: 'measuring',
  transportMs: 100,
  playerMs: 20,
  totalMs: 120,
  missedFrames: 0,
  lastSequence: 41,
  lastFrameAt: Date.now(),
  clock: {
    state: 'ok', mode: 'cross-machine', exact: false, offsetMs: 300, uncertaintyMs: 11,
    warming: false, resyncing: false, wide: false, ageMs: 0, reason: null,
  },
  ...overrides,
});

const rowValue = (label) => {
  const header = screen.getByRole('rowheader', { name: new RegExp(`^${label}`) });
  return within(header.closest('tr')).getByRole('cell').textContent;
};

const show = (sample) => {
  probe.sample = sample;
  render(
    <Provider store={store()}>
      <LatencyGroup connected />
    </Provider>,
  );
};

describe('LatencyGroup', () => {
  beforeEach(() => { probe.sample = null; });

  // The clock error lands entirely in the transport leg, so that row carries the bound too.
  it('puts the clock bound on the transport row and the total, not on the player row', () => {
    show(sampleWith());
    expect(rowValue('Publisher to player')).toBe('100 ms ± 11 ms');
    expect(rowValue('Total')).toBe('120 ms ± 11 ms');
    expect(rowValue('Player jitter buffer')).toBe('20 ms');
  });

  it('shows no bound when the frames are proven to be this page\'s own', () => {
    show(sampleWith({
      clock: {
        state: 'ok', mode: 'same-context', exact: true, offsetMs: 0, uncertaintyMs: 1,
        warming: false, reason: null,
      },
    }));
    expect(rowValue('Publisher to player')).toBe('100 ms');
    expect(rowValue('Clock')).toContain("this page's own stream");
  });

  // The player leg needs no clock, and the first seconds are a warm-up, not a failure.
  it('shows the player leg while the clock is still syncing, and says it is syncing', () => {
    show(sampleWith({
      transportMs: null,
      totalMs: null,
      clock: {
        state: 'unknown', mode: null, exact: false, offsetMs: null, uncertaintyMs: null,
        warming: true, reason: 'Exchanging clock samples (3 of 8).',
      },
    }));
    expect(rowValue('Publisher to player')).toBe('\u2014');
    expect(rowValue('Player jitter buffer')).toBe('20 ms');
    expect(rowValue('Clock')).toBe('syncing clocks');
    expect(screen.queryByText(/too uncertain/)).toBeNull();
  });

  // The clocks moved: the old samples are gone and the range is back in a few seconds.
  it('shows the player leg while syncing again after the clocks moved', () => {
    show(sampleWith({
      transportMs: null,
      totalMs: null,
      clock: {
        state: 'unknown', mode: null, exact: false, offsetMs: null, uncertaintyMs: null,
        warming: false, resyncing: true,
        reason: 'The clocks moved while measuring (a clock step or drift); syncing again.',
      },
    }));
    expect(rowValue('Player jitter buffer')).toBe('20 ms');
    expect(rowValue('Publisher to player')).toBe('\u2014');
    expect(rowValue('Clock')).toBe('syncing clocks');
    expect(screen.queryByText(/too uncertain/)).toBeNull();
  });

  // A long path is a wide range with a hint, never a refusal.
  it('shows a very wide range, with the hint, instead of hiding it', () => {
    show(sampleWith({
      transportMs: 100,
      totalMs: 120,
      clock: {
        state: 'ok', mode: 'cross-machine', exact: false, offsetMs: 300, uncertaintyMs: 250,
        warming: false, resyncing: false, wide: true, ageMs: 100, reason: null,
      },
    }));
    expect(rowValue('Publisher to player')).toBe('0 to 350 ms');
    expect(rowValue('Total')).toBe('0 to 370 ms');
    expect(rowValue('Clock')).toBe('± 250 ms');
    expect(screen.getByText('bound, assuming stable clocks')).toBeTruthy();
    expect(screen.getByText(/Wide because the path between the two ends is long or uneven/)).toBeTruthy();
    expect(screen.queryByText(/too uncertain/)).toBeNull();
  });

  it('writes a range that stays above zero as a figure with its bound', () => {
    show(sampleWith({
      transportMs: 100,
      clock: {
        state: 'ok', mode: 'cross-machine', exact: false, offsetMs: 300, uncertaintyMs: 100,
        warming: false, resyncing: false, wide: true, ageMs: 0, reason: null,
      },
    }));
    expect(rowValue('Publisher to player')).toBe('100 ms ± 100 ms');
  });

  it('says when the clock channel has gone quiet and the range is widening', () => {
    show(sampleWith({
      clock: {
        state: 'ok', mode: 'cross-machine', exact: false, offsetMs: 300, uncertaintyMs: 14,
        warming: false, resyncing: false, wide: false, ageMs: 25_000, reason: null,
      },
    }));
    expect(screen.getByText(/Clock sync lost 25 s ago, range widening/)).toBeTruthy();
  });

  // One threshold: the probe's own stalled status, not a second timer in the panel.
  it('marks the figures stale when the probe says the stream stalled', () => {
    show(sampleWith({ status: 'stalled', lastFrameAt: Date.now() - 2_000 }));
    expect(screen.getByText(/no stamped frame for 2\.\d s/)).toBeTruthy();
    expect(rowValue('Publisher to player')).toBe('100 ms ± 11 ms');
  });

  it('explains nothing in a tooltip only', () => {
    show(sampleWith());
    expect(document.querySelectorAll('#latency-group [title]')).toHaveLength(0);
    expect(screen.getByRole('button', { name: /how the latency figures are measured/i }))
      .toBeTruthy();
  });
});
