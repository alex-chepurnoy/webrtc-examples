import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STALL_MS, STALL_POLL_MS, inboundBytes, startStallWatch } from './stallWatch';
import { clearLog, getEntries } from '../diagnostics/signalLog';

/*
 * The stall watch against a stand-in peer connection whose inbound byte counters the test
 * moves by hand.
 */

const fakePeerConnection = () => {
  const bytes = { video: 0, audio: 0 };
  const kinds = new Set(['video', 'audio']);
  return {
    connectionState: 'connected',
    bytes,
    kinds,
    getStats: vi.fn(async () => {
      const report = new Map();
      for (const kind of kinds) report.set(kind, { type: 'inbound-rtp', kind, bytesReceived: bytes[kind] });
      report.set('t', { type: 'transport', bytesReceived: 999 });
      return report;
    }),
  };
};

const tick = async (ms) => { await vi.advanceTimersByTimeAsync(ms); };

beforeEach(() => {
  vi.useFakeTimers();
  clearLog();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('inboundBytes', () => {
  it('sums inbound RTP per kind and leaves out everything else', () => {
    const report = new Map([
      ['a', { type: 'inbound-rtp', kind: 'video', bytesReceived: 10 }],
      ['b', { type: 'inbound-rtp', kind: 'video', bytesReceived: 5 }],
      ['c', { type: 'outbound-rtp', kind: 'audio', bytesSent: 7 }],
    ]);
    expect(inboundBytes(report)).toEqual({ video: 15, audio: null });
  });
});

describe('startStallWatch', () => {
  it('calls it stalled when neither video nor audio grows for the window', async () => {
    const pc = fakePeerConnection();
    const onStall = vi.fn();
    const stop = startStallWatch({ peerConnection: pc, onStall, now: () => Date.now() });
    pc.bytes.video = 100; pc.bytes.audio = 50;
    await tick(STALL_POLL_MS);
    await tick(STALL_MS - STALL_POLL_MS);
    expect(onStall).not.toHaveBeenCalled();
    await tick(STALL_POLL_MS);
    expect(onStall).toHaveBeenCalledWith({ reason: 'no media received for 10 s' });
    expect(getEntries().map((e) => e.label))
      .toContain('play inbound media stalled for 10 s while connected (possible session loss)');
    stop();
  });

  it('does not call a stream stalled while audio still arrives, as with a frozen picture and sound', async () => {
    const pc = fakePeerConnection();
    const onStall = vi.fn();
    const stop = startStallWatch({ peerConnection: pc, onStall });
    for (let elapsed = 0; elapsed < STALL_MS * 3; elapsed += STALL_POLL_MS) {
      pc.bytes.audio += 40;
      await tick(STALL_POLL_MS);
    }
    expect(onStall).not.toHaveBeenCalled();
    stop();
  });

  it('judges a stream with no audio on video alone', async () => {
    const pc = fakePeerConnection();
    pc.kinds.delete('audio');
    const onStall = vi.fn();
    startStallWatch({ peerConnection: pc, onStall });
    pc.bytes.video = 100;
    await tick(STALL_POLL_MS + STALL_MS + STALL_POLL_MS);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('waits for media to have flowed once before it calls anything a stall', async () => {
    const pc = fakePeerConnection();
    const onStall = vi.fn();
    const stop = startStallWatch({ peerConnection: pc, onStall });
    await tick(STALL_MS * 3);
    expect(onStall).not.toHaveBeenCalled();
    pc.bytes.video = 10;
    await tick(STALL_POLL_MS + STALL_MS + STALL_POLL_MS);
    expect(onStall).toHaveBeenCalledTimes(1);
    stop();
  });

  it('only counts while connected and while no ICE restart is out', async () => {
    const pc = fakePeerConnection();
    let restarting = false;
    const onStall = vi.fn();
    const stop = startStallWatch({ peerConnection: pc, onStall, isIceRestartInProgress: () => restarting });
    pc.connectionState = 'disconnected';
    await tick(STALL_MS * 2);
    pc.connectionState = 'connected';
    restarting = true;
    await tick(STALL_MS * 2);
    expect(onStall).not.toHaveBeenCalled();
    stop();
  });

  it('stops polling when stopped', async () => {
    const pc = fakePeerConnection();
    const stop = startStallWatch({ peerConnection: pc, onStall: vi.fn() });
    await tick(STALL_POLL_MS);
    stop();
    const calls = pc.getStats.mock.calls.length;
    await tick(STALL_MS * 3);
    expect(pc.getStats.mock.calls.length).toBe(calls);
  });
});
