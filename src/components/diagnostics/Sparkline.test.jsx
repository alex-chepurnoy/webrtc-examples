import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import Sparkline from './Sparkline';

const pathOf = (container) => container.querySelector('.wz-spark__line').getAttribute('d');
const moves = (d) => d.split(' ').filter((step) => step.startsWith('M'));
const xs = (d) => d.split(' ').map((step) => Number(step.slice(1).split(',')[0]));
const ys = (d) => d.split(' ').map((step) => Number(step.slice(1).split(',')[1]));

describe('Sparkline', () => {
  it('draws a sample with no figure as a break in the line', () => {
    const { container } = render(<Sparkline points={[1, 2, null, 4, 5]} ariaLabel="Round trip" />);
    expect(moves(pathOf(container))).toHaveLength(2);
  });

  it('keeps each point where its time puts it, so a gap is not closed up', () => {
    // Four figures and a gap: without the gap the last point would move left.
    const withGap = render(<Sparkline points={[1, 2, null, 4, 5]} ariaLabel="a" />);
    const d = pathOf(withGap.container);
    expect(Math.max(...xs(d))).toBeCloseTo(60);
    expect(xs(d)[2]).toBeCloseTo(2 + (3 / 4) * 58);
  });

  it('spans the labeled minute: half a minute of history fills the right half', () => {
    const now = 100_000;
    const times = Array.from({ length: 31 }, (_, i) => now - 30_000 + i * 1000);
    const points = times.map((_, i) => 10 + i);
    const { container } = render(<Sparkline points={points} times={times} ariaLabel="a" />);
    const d = pathOf(container);
    expect(Math.min(...xs(d))).toBeCloseTo(2 + 58 / 2);
    expect(Math.max(...xs(d))).toBeCloseTo(60);
  });

  it('draws a flat series along the middle, as its comment says', () => {
    const { container } = render(<Sparkline points={[5, 5, 5]} ariaLabel="a" />);
    expect(new Set(ys(pathOf(container)))).toEqual(new Set([9]));
  });

  it('gives a screen reader the latest, lowest and highest figures', () => {
    render(<Sparkline points={[40, 12, null, 90, 55]} format={(v) => `${v} ms`} ariaLabel="Round trip" />);
    expect(screen.getByRole('img')).toHaveAttribute(
      'aria-label', 'Round trip: latest 55 ms, lowest 12 ms, highest 90 ms');
  });

  it('draws nothing with fewer than two figures', () => {
    const { container } = render(<Sparkline points={[null, 3, null]} ariaLabel="a" />);
    expect(container.querySelector('svg')).toBeNull();
  });
});
