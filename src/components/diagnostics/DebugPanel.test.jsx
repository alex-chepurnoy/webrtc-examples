import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import DebugPanel from './DebugPanel';
import { clearLog, logEvent } from '../../diagnostics/signalLog';

const scroller = (container) => container.querySelector('.wz-debug__scroller');

beforeEach(() => clearLog());
afterEach(() => clearLog());

describe('DebugPanel', () => {
  // The buffer holds 500 entries. Once full its length never changes, which is what Follow
  // used to key on.
  it('keeps following after the buffer is full', () => {
    act(() => {
      for (let i = 0; i < 500; i += 1) logEvent('info', 'pc', `e${i}`);
    });
    const { container } = render(<DebugPanel defaultOpen />);
    const el = scroller(container);

    el.scrollTop = 120;
    act(() => logEvent('info', 'pc', 'one more'));
    expect(el.scrollTop).toBe(0);

    el.scrollTop = 120;
    act(() => logEvent('info', 'pc', 'and another'));
    expect(el.scrollTop).toBe(0);
  });

  it('marks the active channel filter as pressed', () => {
    render(<DebugPanel defaultOpen />);
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'ICE' })).toHaveAttribute('aria-pressed', 'false');
    act(() => screen.getByRole('button', { name: 'ICE' }).click());
    expect(screen.getByRole('button', { name: 'ICE' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
  });
});
