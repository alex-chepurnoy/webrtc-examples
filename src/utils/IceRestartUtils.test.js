import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { attachIceRestartRecovery, consumeIceRestartOffer } from './IceRestartUtils';

// Just the ICE side of a peer connection: its state and restartIce().
const fakePeerConnection = () => {
  const pc = {
    iceConnectionState: 'connected',
    restartIce: vi.fn(),
    setIce(state) { pc.iceConnectionState = state; if (pc.oniceconnectionstatechange) pc.oniceconnectionstatechange(); },
  };
  return pc;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('attachIceRestartRecovery', () => {
  it('restarts on failure and reports the restart as in progress until ICE connects', () => {
    const pc = fakePeerConnection();
    const recovery = attachIceRestartRecovery(pc);
    pc.setIce('failed');
    expect(pc.restartIce).toHaveBeenCalledTimes(1);
    expect(recovery.isRestartInProgress()).toBe(true);
    expect(consumeIceRestartOffer(pc)).toBe(true);
    pc.setIce('connected');
    expect(recovery.isRestartInProgress()).toBe(false);
  });

  it('asks again after a busy answer, but only if ICE is still down', () => {
    const pc = fakePeerConnection();
    const recovery = attachIceRestartRecovery(pc);
    pc.setIce('failed');
    recovery.retryRestart(2000, 'retry after 425');
    vi.advanceTimersByTime(2000);
    expect(pc.restartIce).toHaveBeenCalledTimes(2);

    recovery.retryRestart(2000, 'retry after 425');
    pc.setIce('connected');
    vi.advanceTimersByTime(2000);
    expect(pc.restartIce).toHaveBeenCalledTimes(2);
  });

  it('remembers an answered restart until ICE connects again', () => {
    const pc = fakePeerConnection();
    const recovery = attachIceRestartRecovery(pc);
    expect(recovery.hasRestartBeenAnswered()).toBe(false);
    recovery.notifyRestartAnswered();
    expect(recovery.hasRestartBeenAnswered()).toBe(true);
    pc.setIce('connected');
    expect(recovery.hasRestartBeenAnswered()).toBe(false);
  });

  it('does nothing more once disposed, pending timers included', () => {
    const pc = fakePeerConnection();
    const recovery = attachIceRestartRecovery(pc);
    pc.setIce('disconnected');
    recovery.dispose();
    expect(pc.oniceconnectionstatechange).toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(pc.restartIce).not.toHaveBeenCalled();
  });
});
