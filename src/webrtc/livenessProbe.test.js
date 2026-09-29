import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LIVENESS_PROBE_GRACE_MS,
  LIVENESS_PROBE_INTERVAL_MS,
  LIVENESS_PROBE_RECHECK_MS,
  livenessProbeUrl,
  startLivenessProbe,
} from './livenessProbe';
import { LOOKUP_ERROR, LOOKUP_OK, LOOKUP_UNREACHABLE } from '../utils/RenditionUtils';
import { clearLog, getEntries } from '../diagnostics/signalLog';

/*
 * The liveness check against a scripted lookup. random 0.5 makes the jitter zero, so the
 * grace, the interval and the recheck land exactly.
 */

const labels = () => getEntries().map((e) => `${e.direction} ${e.channel}: ${e.label}`);

const setup = (answers, { iceRestart = () => false } = {}) => {
  const queue = [...answers];
  const list = vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0]));
  const onLost = vi.fn();
  const stop = startLivenessProbe({
    signalingURL: 'wss://engine.example/webrtc-session.json',
    applicationName: 'live',
    streamName: 'cam',
    isIceRestartInProgress: iceRestart,
    onLost,
    list,
    random: () => 0.5,
  });
  return { list, onLost, stop };
};

const live = { status: LOOKUP_OK, streams: ['cam', 'other'] };
const missing = { status: LOOKUP_OK, streams: ['other'] };

// Timers and the awaited lookup both have to run.
const advance = async (ms) => { await vi.advanceTimersByTimeAsync(ms); };

beforeEach(() => {
  vi.useFakeTimers();
  clearLog();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('livenessProbe', () => {
  it('asks on its own socket, marked so it can be told from the session socket', () => {
    expect(livenessProbeUrl('wss://engine.example/webrtc-session.json'))
      .toBe('wss://engine.example/webrtc-session.json?webrtcImplementation=v2&wzProbe=liveness');
    // A WHIP origin in the field still gives the signaling endpoint.
    expect(livenessProbeUrl('https://engine.example'))
      .toBe('wss://engine.example/webrtc-session.json?webrtcImplementation=v2&wzProbe=liveness');
  });

  it('waits out the grace period, then checks on the interval', async () => {
    const t = setup([live]);
    await advance(LIVENESS_PROBE_GRACE_MS - 1);
    expect(t.list).not.toHaveBeenCalled();
    await advance(1);
    expect(t.list).toHaveBeenCalledTimes(1);
    expect(t.list.mock.calls[0][0]).toContain('wzProbe=liveness');
    await advance(LIVENESS_PROBE_INTERVAL_MS);
    expect(t.list).toHaveBeenCalledTimes(2);
    expect(t.onLost).not.toHaveBeenCalled();
    expect(labels()).toContain('info ws: publish liveness check: stream "cam" is live on the Engine, checking every 20 s');
    t.stop();
  });

  it('does not call one miss a loss', async () => {
    const t = setup([live, missing, live]);
    await advance(LIVENESS_PROBE_GRACE_MS + LIVENESS_PROBE_INTERVAL_MS + LIVENESS_PROBE_RECHECK_MS + LIVENESS_PROBE_INTERVAL_MS);
    expect(t.onLost).not.toHaveBeenCalled();
    expect(labels()).toContain('warn ws: publish stream "cam" not listed by application "live" (1 of 2), checking again');
    t.stop();
  });

  it('calls two misses in a row a lost session', async () => {
    const t = setup([missing, missing]);
    await advance(LIVENESS_PROBE_GRACE_MS);
    expect(t.onLost).not.toHaveBeenCalled();
    await advance(LIVENESS_PROBE_RECHECK_MS);
    expect(t.onLost).toHaveBeenCalledWith({ reason: 'stream "cam" no longer on the Engine' });
    expect(labels()).toContain(
      'error ws: publish stream "cam" no longer on the Engine (application "live" did not list it 2 times in a row)');
    // Once: it stops itself.
    await advance(LIVENESS_PROBE_INTERVAL_MS * 3);
    expect(t.list).toHaveBeenCalledTimes(2);
  });

  it('treats 404 as the application gone, which no republish can fix', async () => {
    const t = setup([{ status: LOOKUP_ERROR, code: 404, message: 'Application live does not exist.' }]);
    await advance(LIVENESS_PROBE_GRACE_MS);
    expect(t.onLost).toHaveBeenCalledWith({ reason: 'application "live" returned 404', terminal: true });
    expect(labels()).toContain('error ws: publish stream "cam" no longer on the Engine (application "live" returned 404)');
  });

  it('turns itself off, with one warning, when the Engine will not answer the question', async () => {
    const t = setup([{ status: LOOKUP_ERROR, code: 400, message: 'Application live does not have WebRTC stream query enabled.' }]);
    await advance(LIVENESS_PROBE_GRACE_MS + LIVENESS_PROBE_INTERVAL_MS * 5);
    expect(t.list).toHaveBeenCalledTimes(1);
    expect(t.onLost).not.toHaveBeenCalled();
    const warnings = labels().filter((l) => l.startsWith('warn ws: publish liveness check off'));
    expect(warnings).toEqual([
      'warn ws: publish liveness check off: the Engine refused it (400: Application live does not have WebRTC stream query enabled.)',
    ]);
  });

  it('reads no answer as no evidence either way', async () => {
    const t = setup([{ status: LOOKUP_UNREACHABLE }, missing, { status: LOOKUP_UNREACHABLE }, live]);
    await advance(LIVENESS_PROBE_GRACE_MS + LIVENESS_PROBE_INTERVAL_MS * 4);
    expect(t.onLost).not.toHaveBeenCalled();
    t.stop();
  });

  it('does not ask while an ICE restart is out', async () => {
    let restarting = true;
    const t = setup([missing, missing], { iceRestart: () => restarting });
    await advance(LIVENESS_PROBE_GRACE_MS + LIVENESS_PROBE_INTERVAL_MS * 2);
    expect(t.list).not.toHaveBeenCalled();
    restarting = false;
    await advance(LIVENESS_PROBE_INTERVAL_MS);
    expect(t.list).toHaveBeenCalledTimes(1);
    t.stop();
  });

  it('asks nothing more once stopped, even with a lookup in flight', async () => {
    let resolve;
    const list = vi.fn(() => new Promise((r) => { resolve = r; }));
    const onLost = vi.fn();
    const stop = startLivenessProbe({
      signalingURL: 'wss://engine.example/webrtc-session.json',
      applicationName: 'live', streamName: 'cam', onLost, list, random: () => 0.5,
    });
    await advance(LIVENESS_PROBE_GRACE_MS);
    stop();
    resolve(missing);
    await advance(LIVENESS_PROBE_INTERVAL_MS * 3);
    expect(list).toHaveBeenCalledTimes(1);
    expect(onLost).not.toHaveBeenCalled();
  });
});
