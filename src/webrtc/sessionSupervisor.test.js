import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionSupervisor, MAX_RECONNECT_ATTEMPTS } from './sessionSupervisor';
import { clearLog, getEntries } from '../diagnostics/signalLog';

/*
 * The supervisor with a scripted startAttempt: each call records its settings and callbacks
 * and returns a handle that counts its closes, so every test drives the attempts by hand.
 * random is fixed at 0.5, which makes the jitter zero and the delays exact.
 */

const labels = () => getEntries().map((e) => `${e.direction} ${e.channel}: ${e.label}`);

const setup = ({ monitors = [], readLive, isWaitingForStream, checkAttempt } = {}) => {
  const attempts = [];
  const startAttempt = vi.fn((settings, callbacks) => {
    const handle = { close: vi.fn(), isIceRestartInProgress: () => false };
    attempts.push({ settings, callbacks, handle });
    return handle;
  });
  const ui = { onReconnecting: vi.fn(), onAttemptEnded: vi.fn(), onFailed: vi.fn() };
  const supervisor = createSessionSupervisor({
    role: 'publish',
    startAttempt,
    monitors,
    words: { lost: 'republishing', attempt: 'republish attempt' },
    isWaitingForStream,
    checkAttempt,
    random: () => 0.5,
  });
  const start = () => supervisor.start({
    settings: { streamName: 'cam' },
    readLive,
    makeCallbacks: () => ({ onConnectionStateChange: vi.fn() }),
    ui,
  });
  const connect = (index) => attempts[index].callbacks.onConnectionStateChange({ connected: true, state: 'connected' });
  return { attempts, startAttempt, ui, supervisor, start, connect };
};

beforeEach(() => {
  vi.useFakeTimers();
  clearLog();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sessionSupervisor', () => {
  it('starts once however often start is called, as a StrictMode double effect does', () => {
    const t = setup();
    expect(t.start()).toBe(true);
    expect(t.start()).toBe(false);
    expect(t.startAttempt).toHaveBeenCalledTimes(1);
    expect(t.supervisor.active).toBe(true);
  });

  it('reports a first attempt that fails as an error, without retrying', () => {
    const t = setup();
    t.start();
    t.attempts[0].callbacks.onError({ message: 'Websocket Error: refused', status: 503 });
    vi.advanceTimersByTime(60_000);
    expect(t.startAttempt).toHaveBeenCalledTimes(1);
    expect(t.ui.onFailed).toHaveBeenCalledWith('Websocket Error: refused');
    expect(t.supervisor.active).toBe(false);
  });

  it('republishes on a fresh attempt after a lost session, and says so in the panel', () => {
    const t = setup();
    t.start();
    t.connect(0);
    t.attempts[0].callbacks.onSessionLost({ reason: 'signaling socket closed unexpectedly (code 1006)' });

    // The old attempt is closed with CLOSE/DELETE, and nothing new starts before the backoff.
    expect(t.attempts[0].handle.close).toHaveBeenCalledWith({ sendClose: true });
    expect(t.ui.onReconnecting).toHaveBeenLastCalledWith(
      { attempt: 1, max: MAX_RECONNECT_ATTEMPTS, reason: 'signaling socket closed unexpectedly (code 1006)' });
    expect(t.startAttempt).toHaveBeenCalledTimes(1);
    expect(labels()).toContain(
      'warn pc: publish session lost (signaling socket closed unexpectedly (code 1006)): republishing, attempt 1 of 6 in 1 s');

    vi.advanceTimersByTime(1000);
    expect(t.startAttempt).toHaveBeenCalledTimes(2);
    expect(labels()).toContain('info pc: publish republish attempt 1: new peer connection and signaling');

    vi.advanceTimersByTime(2500);
    t.connect(1);
    expect(t.ui.onReconnecting).toHaveBeenLastCalledWith(null);
    expect(labels()).toContain('info pc: publish recovered after 1 attempt (3.5 s)');
  });

  it('reads the live settings again for every attempt', () => {
    let track = 'camera-1';
    const t = setup({ readLive: () => ({ videoTrack: track }) });
    t.start();
    t.connect(0);
    track = 'camera-2';
    t.attempts[0].callbacks.onSessionLost({ reason: 'lost' });
    vi.advanceTimersByTime(1000);
    expect(t.attempts[0].settings).toEqual({ streamName: 'cam', videoTrack: 'camera-1' });
    expect(t.attempts[1].settings).toEqual({ streamName: 'cam', videoTrack: 'camera-2' });
  });

  it('ignores everything from an attempt it has replaced', () => {
    const t = setup();
    t.start();
    t.connect(0);
    const old = t.attempts[0].callbacks;
    old.onSessionLost({ reason: 'lost' });
    vi.advanceTimersByTime(1000);

    old.onError({ message: 'late' });
    old.onSessionLost({ reason: 'late again' });
    old.onConnectionStateChange({ connected: true });
    vi.advanceTimersByTime(60_000);

    // Only the replacement's own timeout moved it on; the old callbacks did nothing.
    expect(labels().some((l) => l.includes('late'))).toBe(false);
    expect(t.ui.onFailed).not.toHaveBeenCalledWith(expect.stringContaining('late'));
  });

  it('backs off 1, 2, 4, 8, 15 s and gives up after six attempts', () => {
    const t = setup();
    t.start();
    t.connect(0);
    t.attempts[0].callbacks.onSessionLost({ reason: 'socket closed' });

    const delays = [1000, 2000, 4000, 8000, 15000, 15000];
    delays.forEach((delay, index) => {
      vi.advanceTimersByTime(delay - 1);
      expect(t.startAttempt).toHaveBeenCalledTimes(index + 1);
      vi.advanceTimersByTime(1);
      expect(t.startAttempt).toHaveBeenCalledTimes(index + 2);
      t.attempts[index + 1].callbacks.onError({ message: 'Websocket Error: refused' });
    });

    expect(t.startAttempt).toHaveBeenCalledTimes(7);
    expect(t.supervisor.active).toBe(false);
    expect(t.ui.onFailed).toHaveBeenCalledWith(
      'Lost the session with the Engine: socket closed. Gave up after 6 attempts.');
    expect(labels()).toContain('error pc: publish recovery gave up after 6 attempts');
    expect(t.ui.onReconnecting).toHaveBeenLastCalledWith(null);
  });

  it('retries a 503 "in use" and stops at once on a status no retry can change', () => {
    const t = setup();
    t.start();
    t.connect(0);
    t.attempts[0].callbacks.onSessionLost({ reason: 'lost' });
    vi.advanceTimersByTime(1000);
    t.attempts[1].callbacks.onError({ message: 'Stream name is already in use', status: 503 });
    expect(t.supervisor.active).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(t.startAttempt).toHaveBeenCalledTimes(3);

    t.attempts[2].callbacks.onError({ message: 'Application live does not exist.', status: 404 });
    expect(t.supervisor.active).toBe(false);
    expect(t.ui.onFailed).toHaveBeenCalledWith(
      'Lost the session with the Engine: Application live does not exist.. Not retrying.');
  });

  it('gives up without retrying on a terminal loss', () => {
    const t = setup();
    t.start();
    t.connect(0);
    t.attempts[0].callbacks.onSessionLost({ reason: 'application "live" returned 404', terminal: true });
    vi.advanceTimersByTime(60_000);
    expect(t.startAttempt).toHaveBeenCalledTimes(1);
    expect(t.ui.onFailed).toHaveBeenCalledWith(
      'Lost the session with the Engine: application "live" returned 404. Not retrying.');
  });

  it('cancels the backoff on Stop', () => {
    const t = setup();
    t.start();
    t.connect(0);
    t.attempts[0].callbacks.onSessionLost({ reason: 'lost' });
    expect(t.supervisor.stop()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(t.startAttempt).toHaveBeenCalledTimes(1);
    expect(t.supervisor.active).toBe(false);
    expect(t.ui.onReconnecting).toHaveBeenLastCalledWith(null);
    expect(labels()).toContain('info pc: publish recovery canceled by Stop during attempt 1 of 6');
  });

  it('closes an attempt still starting on Stop, and ignores what it reports afterwards', () => {
    const t = setup();
    t.start();
    t.supervisor.stop();
    expect(t.attempts[0].handle.close).toHaveBeenCalledWith({ sendClose: false });
    t.attempts[0].callbacks.onError({ message: 'late failure' });
    t.attempts[0].callbacks.onConnectionStateChange({ connected: true });
    expect(t.ui.onFailed).not.toHaveBeenCalled();
    expect(t.supervisor.active).toBe(false);
    // A new session can start after it.
    expect(t.start()).toBe(true);
  });

  it('fails a replacement that never connects', () => {
    const t = setup();
    t.start();
    t.connect(0);
    t.attempts[0].callbacks.onSessionLost({ reason: 'lost' });
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(20_000);
    expect(labels()).toContain(
      'warn pc: publish republish attempt 1 failed (not connected after 20 s): attempt 2 of 6 in 2 s');
    expect(t.attempts[1].handle.close).toHaveBeenCalledWith({ sendClose: true });
  });

  it('runs monitors while connected, once per attempt, and treats their report as a loss', () => {
    const stop = vi.fn();
    let report;
    const monitor = vi.fn(({ reportLost }) => { report = reportLost; return stop; });
    const t = setup({ monitors: [monitor] });
    t.start();
    t.connect(0);
    // An ICE blip goes back to connected on the same attempt: still one monitor.
    t.connect(0);
    expect(monitor).toHaveBeenCalledTimes(1);

    report({ reason: 'stream "cam" no longer on the Engine' });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(labels()).toContain(
      'warn pc: publish session lost (stream "cam" no longer on the Engine): republishing, attempt 1 of 6 in 1 s');

    // A stopped monitor's late report changes nothing.
    report({ reason: 'again' });
    expect(labels().some((l) => l.includes('again'))).toBe(false);
  });

  describe('waiting for a stream that is not running yet', () => {
    const notRunning = { message: 'Websocket Error: Live stream is not running: cam', status: 502 };
    const waitingSetup = () => setup({ isWaitingForStream: (failure) => failure.status === 502 });

    it('asks again every 15 s without spending attempts, then gives up after 2 minutes', () => {
      const t = waitingSetup();
      t.start();
      t.connect(0);
      t.attempts[0].callbacks.onSessionLost({ reason: 'no media received for 10 s' });
      vi.advanceTimersByTime(1000);
      expect(t.startAttempt).toHaveBeenCalledTimes(2);

      // Ten "not running" answers are more than the six attempts, and none of them count.
      for (let index = 1; index <= 7; index += 1) {
        t.attempts[index].callbacks.onError(notRunning);
        expect(t.ui.onReconnecting).toHaveBeenLastCalledWith(
          { attempt: 1, max: 6, reason: 'no media received for 10 s', waiting: 'stream' });
        vi.advanceTimersByTime(15_000);
        expect(t.startAttempt).toHaveBeenCalledTimes(index + 2);
      }
      expect(labels()).toContain('warn pc: publish waiting for stream "cam" to come back (1 s of 120 s)');
      expect(labels()).toContain('warn pc: publish waiting for stream "cam" to come back (91 s of 120 s)');
      expect(labels()).toContain('info pc: publish republish attempt 1, asking again');
      expect(t.supervisor.active).toBe(true);

      // 106 s in: another 15 s would pass the limit, so this is the end.
      t.attempts[8].callbacks.onError(notRunning);
      expect(t.supervisor.active).toBe(false);
      expect(labels()).toContain('error pc: publish recovery gave up: stream "cam" did not come back within 120 s');
      expect(t.ui.onFailed).toHaveBeenCalledWith(
        'Lost the session with the Engine: no media received for 10 s. The stream did not come back within 2 minutes.');
    });

    it('still counts a failure of the connection itself as an attempt', () => {
      const t = waitingSetup();
      t.start();
      t.connect(0);
      t.attempts[0].callbacks.onSessionLost({ reason: 'socket closed' });
      vi.advanceTimersByTime(1000);
      t.attempts[1].callbacks.onError(notRunning);
      vi.advanceTimersByTime(15_000);
      t.attempts[2].callbacks.onError({ message: 'Websocket Error: refused' });
      expect(t.ui.onReconnecting).toHaveBeenLastCalledWith({ attempt: 2, max: 6, reason: 'socket closed' });
      vi.advanceTimersByTime(2000);
      t.connect(3);
      expect(labels()).toContain('info pc: publish recovered after 2 attempts (18 s)');
    });
  });

  it('does not let a session that connects and dies at once recover forever', () => {
    const t = setup();
    t.start();
    t.connect(0);
    const delays = [1000, 2000, 4000, 8000, 15000, 15000];
    for (let index = 0; index < 6; index += 1) {
      t.attempts[index].callbacks.onSessionLost({ reason: 'socket closed' });
      vi.advanceTimersByTime(delays[index]);
      t.connect(index + 1);
      vi.advanceTimersByTime(5000);
    }
    t.attempts[6].callbacks.onSessionLost({ reason: 'socket closed' });
    expect(t.supervisor.active).toBe(false);
    expect(t.ui.onFailed).toHaveBeenCalledWith('Lost the session with the Engine: socket closed. Gave up after 6 attempts.');
  });

  it('starts the count again once a recovered session has stayed up 30 s', () => {
    const t = setup();
    t.start();
    t.connect(0);
    t.attempts[0].callbacks.onSessionLost({ reason: 'socket closed' });
    vi.advanceTimersByTime(1000);
    t.connect(1);
    vi.advanceTimersByTime(30_000);
    t.attempts[1].callbacks.onSessionLost({ reason: 'socket closed' });
    expect(t.ui.onReconnecting).toHaveBeenLastCalledWith({ attempt: 1, max: 6, reason: 'socket closed' });
  });

  it('waits up to 2 minutes for an Engine that cannot be reached, without spending attempts', () => {
    const t = setup();
    t.start();
    t.connect(0);
    t.attempts[0].callbacks.onSessionLost({ reason: 'signaling socket closed unexpectedly (code 1006)' });
    vi.advanceTimersByTime(1000);
    for (let index = 1; index <= 7; index += 1) {
      t.attempts[index].callbacks.onError({ message: 'Websocket Error: unreachable', unreachable: true });
      expect(t.ui.onReconnecting).toHaveBeenLastCalledWith(expect.objectContaining({ attempt: 1, waiting: 'engine' }));
      vi.advanceTimersByTime(15_000);
    }
    expect(labels()).toContain('warn pc: publish waiting for the Engine to be reachable again (1 s of 120 s)');
    t.attempts[8].callbacks.onError({ message: 'Websocket Error: unreachable', unreachable: true });
    expect(t.supervisor.active).toBe(false);
    expect(t.ui.onFailed).toHaveBeenCalledWith(
      'Lost the session with the Engine: signaling socket closed unexpectedly (code 1006). The Engine was not reachable again within 2 minutes.');
  });

  it('stops instead of starting a replacement the settings cannot carry', () => {
    let ended = false;
    const t = setup({
      checkAttempt: () => (ended ? { reason: 'the camera was released', message: 'Publish stopped.' } : null),
    });
    t.start();
    t.connect(0);
    ended = true;
    t.attempts[0].callbacks.onSessionLost({ reason: 'socket closed' });
    vi.advanceTimersByTime(1000);
    expect(t.startAttempt).toHaveBeenCalledTimes(1);
    expect(t.supervisor.active).toBe(false);
    expect(t.ui.onFailed).toHaveBeenCalledWith('Publish stopped.');
    expect(labels()).toContain('error pc: publish stopped instead of starting republish attempt 1: the camera was released');
  });
});

describe('publishSupervisor', () => {
  it('will not republish tracks the Publish page has released', async () => {
    const { endedTracksProblem } = await import('./publishSupervisor');
    expect(endedTracksProblem({ audioTrack: { readyState: 'live' }, videoTrack: { readyState: 'live' } })).toBeNull();
    expect(endedTracksProblem({ audioTrack: null, videoTrack: null })).toBeNull();
    expect(endedTracksProblem({ audioTrack: { readyState: 'live' }, videoTrack: { readyState: 'ended' } }))
      .toMatchObject({ reason: 'camera released when the Publish page closed' });
  });
});
