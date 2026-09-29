/*
 * Keeps one publish or one play session going when the Engine loses it.
 *
 * An ICE restart only repairs the network path (IceRestartUtils). When the Engine restarts,
 * or the application restarts under a live session, the session on the Engine is gone and
 * the page has to open a new one: a new peer connection on a new socket, or a new WHIP/WHEP
 * POST. The supervisor is the only caller of startPublish and startPlay, so it can do that.
 *
 * It owns:
 *   - a generation counter: every attempt's callbacks carry the generation they were made
 *     for, and anything from an older attempt is dropped, so a late event from a replaced
 *     connection cannot change the state of the one that replaced it;
 *   - the classification: the first attempt failing is an ordinary error, as it always was,
 *     because nothing was ever working; a session lost after it was live is recovered;
 *   - the loop: backoff 1, 2, 4, 8, 15 s with jitter, six attempts, then an error.
 *
 * One supervisor per role, created at module level, so StrictMode's double mount and a page
 * left and come back to find the one already running instead of starting a second.
 */

import { logEvent } from '../diagnostics/signalLog';

export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
export const MAX_RECONNECT_ATTEMPTS = 6;

// A replacement that neither connects nor fails in this long counts as failed, so one silent
// attempt cannot hold the loop. The first attempt keeps the limits it always had.
export const ATTEMPT_CONNECT_TIMEOUT_MS = 20000;

// Up to this share either way, so many pages that lost the same Engine do not all come back
// at the same instant.
const JITTER = 0.2;

/*
 * Statuses a replacement attempt can get that no retry changes: not authorized, WebRTC or
 * publishing switched off, or an application that does not exist. Everything else, 503
 * "Stream name is already in use" included, is worth another try.
 */
const TERMINAL_STATUSES = new Set([401, 403, 404]);

/*
 * Two failures of a replacement are waited out rather than counted: a stream that is not
 * running yet (its publisher is on its own way back, and after an application restart the
 * publisher needs up to a minute to notice), and an Engine that cannot be reached at all
 * (it is restarting). Both are asked again at this cadence, for up to this long after the
 * loss, without spending the attempts, which are kept for failures of the connection itself.
 */
export const WAIT_FOR_STREAM_RETRY_MS = 15000;
export const WAIT_FOR_STREAM_LIMIT_MS = 120000;

/*
 * A recovered session counts as working again only once it has stayed up this long. Until
 * then a new loss carries on the same count, so a session that connects and dies at once
 * cannot recover forever.
 */
export const STABLE_AFTER_MS = 30000;

// What a wait is for, as the panel, the badge and the final error name it.
const WAITS = {
  stream: {
    what: (name) => `stream "${name}" to come back`,
    giveUp: (name, limit) => `stream "${name}" did not come back within ${limit}`,
    message: (minutes) => `The stream did not come back within ${minutes} minutes.`,
  },
  engine: {
    what: () => 'the Engine to be reachable again',
    giveUp: (name, limit) => `the Engine was not reachable again within ${limit}`,
    message: (minutes) => `The Engine was not reachable again within ${minutes} minutes.`,
  },
};

// The e2e build is not a production build; only there, and in the unit tests, may the
// timings be shortened. A deployed page always runs on the real ones.
const TIMINGS_OVERRIDABLE = import.meta.env.MODE !== 'production';

/*
 * The timings, overridable from window.__wzReconnectTimings. For the end-to-end tests only:
 * a real application restart takes a liveness check a minute to notice, and a test cannot
 * wait that long for every case. Ignored in a production build. Unknown keys and bad values
 * fall back to the defaults.
 */
export const reconnectTiming = (key, fallback) => {
  try {
    const overrides = !TIMINGS_OVERRIDABLE || typeof window === 'undefined' ? null : window.__wzReconnectTimings;
    const value = overrides ? overrides[key] : undefined;
    if (Array.isArray(fallback))
      return Array.isArray(value) && value.length > 0 && value.every((n) => Number.isFinite(n) && n >= 0)
        ? value : fallback;
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  } catch {
    return fallback;
  }
};

export const withJitter = (ms, random = Math.random) =>
  Math.max(0, Math.round(ms * (1 - JITTER + 2 * JITTER * random())));

/** Seconds for the panel: "1 s", "7.2 s". */
export const formatSeconds = (ms) => `${Number((ms / 1000).toFixed(1))} s`;

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * role:         'publish' | 'play', the prefix of every panel line
 * startAttempt: (settings, callbacks) => handle with close({sendClose}); startPublish or startPlay
 * monitors:     functions started when an attempt connects, each returning its stop function.
 *               They get { settings, handle, reportLost(info) }.
 * words:        { lost, attempt } for the panel: "republishing" / "republish attempt"
 * isWaitingForStream: (failure) => true for a failure that means the stream is not running
 *               yet (the player's 502 and 514), which is waited for instead of counted.
 *               A failure with unreachable set (no connection to the Engine at all) is
 *               waited for the same way, in both roles.
 * checkAttempt: (settings) => null, or { reason, message } to stop instead of starting a
 *               replacement with these settings
 */
export const createSessionSupervisor = ({
  role,
  startAttempt,
  monitors = [],
  words = { lost: 'reconnecting', attempt: 'reconnect attempt' },
  isWaitingForStream = () => false,
  checkAttempt = () => null,
  now = () => Date.now(),
  random = Math.random,
}) => {
  let context = null;
  let active = false;
  let generation = 0;
  // 'idle' | 'starting' (first attempt, never connected) | 'live' | 'reconnecting'
  let phase = 'idle';
  let current = null;
  let attempt = 0;
  let lostAt = 0;
  let liveSince = 0;
  let lostReason = '';
  let backoffTimer = null;
  let connectTimer = null;
  let stopMonitors = [];
  let monitoredGeneration = 0;
  // The generation that has already failed. Its callbacks, timers and monitors go quiet at
  // once, not only when the next attempt starts, so one loss is never counted twice.
  let failedGeneration = 0;

  const ui = (name, ...args) => {
    const fn = context && context.ui && context.ui[name];
    if (typeof fn === 'function') fn(...args);
  };

  const stopWatching = () => {
    const stops = stopMonitors;
    stopMonitors = [];
    monitoredGeneration = 0;
    for (const stop of stops) {
      try { stop(); } catch { /* a monitor that cannot stop has nothing left to do */ }
    }
  };

  const clearTimers = () => {
    if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null; }
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  };

  const closeCurrent = (sendClose) => {
    const handle = current;
    current = null;
    if (!handle || typeof handle.close !== 'function') return;
    try {
      handle.close({ sendClose });
    } catch (error) {
      logEvent('error', 'pc', `${role} could not close the old attempt`, error?.message ?? String(error));
    }
  };

  // The end of the supervised session, whichever way it ends.
  const finish = () => {
    const wasReconnecting = phase === 'reconnecting';
    active = false;
    phase = 'idle';
    generation += 1;
    clearTimers();
    stopWatching();
    closeCurrent(false);
    if (wasReconnecting) ui('onReconnecting', null);
  };

  const giveUp = (reason, lastReason, terminal) => {
    const attempts = attempt;
    logEvent('error', 'pc',
      terminal
        ? `${role} recovery stopped: ${lastReason}`
        : `${role} recovery gave up after ${plural(attempts, 'attempt')}`,
      { lostBecause: reason, lastFailure: lastReason });
    finish();
    ui('onFailed', terminal
      ? `Lost the session with the Engine: ${lastReason}. Not retrying.`
      : `Lost the session with the Engine: ${reason}. Gave up after ${plural(attempts, 'attempt')}.`);
  };

  // Asks again for a stream that is not running yet, or an Engine that cannot be reached; the
  // attempt count stays where it is.
  const waitFor = (kind, reason) => {
    const wait = WAITS[kind];
    const limit = reconnectTiming('waitLimitMs', WAIT_FOR_STREAM_LIMIT_MS);
    const cadence = reconnectTiming('waitRetryMs', WAIT_FOR_STREAM_RETRY_MS);
    const waited = now() - lostAt;
    const streamName = context && context.settings ? context.settings.streamName : '';
    if (waited + cadence > limit) {
      logEvent('error', 'pc', `${role} recovery gave up: ${wait.giveUp(streamName, formatSeconds(limit))}`,
        { lostBecause: lostReason, lastFailure: reason });
      finish();
      ui('onFailed', `Lost the session with the Engine: ${lostReason}. ${wait.message(Math.round(limit / 60000))}`);
      return;
    }
    logEvent('warn', 'pc',
      `${role} waiting for ${wait.what(streamName)} (${Math.round(waited / 1000)} s of ${Math.round(limit / 1000)} s)`,
      { lastAnswer: reason, askingAgainIn: formatSeconds(cadence) });
    ui('onReconnecting', { attempt, max: MAX_RECONNECT_ATTEMPTS, reason: lostReason, waiting: kind });
    backoffTimer = setTimeout(() => {
      backoffTimer = null;
      if (!active) return;
      logEvent('info', 'pc', `${role} ${words.attempt} ${attempt}, asking again`, null);
      launch();
    }, cadence);
  };

  const schedule = (describe) => {
    attempt += 1;
    const delays = reconnectTiming('delaysMs', RECONNECT_DELAYS_MS);
    const delay = withJitter(delays[Math.min(attempt - 1, delays.length - 1)], random);
    logEvent('warn', 'pc', describe(`attempt ${attempt} of ${MAX_RECONNECT_ATTEMPTS} in ${formatSeconds(delay)}`),
      { reason: lostReason });
    ui('onReconnecting', { attempt, max: MAX_RECONNECT_ATTEMPTS, reason: lostReason });
    const scheduledFor = attempt;
    backoffTimer = setTimeout(() => {
      backoffTimer = null;
      if (!active) return;
      logEvent('info', 'pc', `${role} ${words.attempt} ${scheduledFor}: new peer connection and signaling`, null);
      launch();
    }, delay);
  };

  const failed = (info) => {
    failedGeneration = generation;
    const reason = info && info.reason ? info.reason : 'unknown reason';
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    stopWatching();
    // CLOSE or DELETE on the way out, so the Engine lets go of the stream name before we ask
    // for it again.
    closeCurrent(true);
    ui('onAttemptEnded');

    if (phase === 'starting') {
      // Nothing ever worked, so this is a setup problem (address, application, codec) and
      // retrying would only repeat it. Reported as it always was.
      finish();
      ui('onFailed', info.message || `Lost the session with the Engine: ${reason}`);
      return;
    }

    if (phase === 'live') {
      phase = 'reconnecting';
      lostAt = now();
      lostReason = reason;
      // A session that stayed up counts as working again; one that died soon after a
      // recovery carries on the same count.
      if (now() - liveSince >= reconnectTiming('stableMs', STABLE_AFTER_MS)) attempt = 0;
      if (info.terminal) { giveUp(reason, reason, true); return; }
      if (attempt >= MAX_RECONNECT_ATTEMPTS) { giveUp(reason, reason, false); return; }
      schedule((next) => `${role} session lost (${reason}): ${words.lost}, ${next}`);
      return;
    }

    // One of the replacements failed.
    if (info.terminal || TERMINAL_STATUSES.has(info.status)) { giveUp(lostReason, reason, true); return; }
    if (isWaitingForStream(info)) { waitFor('stream', reason); return; }
    if (info.unreachable) { waitFor('engine', reason); return; }
    if (attempt >= MAX_RECONNECT_ATTEMPTS) { giveUp(lostReason, reason, false); return; }
    const failedAttempt = attempt;
    schedule((next) => `${role} ${words.attempt} ${failedAttempt} failed (${reason}): ${next}`);
  };

  const connected = (gen, settings) => {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    if (phase === 'reconnecting') {
      logEvent('info', 'pc',
        `${role} recovered after ${plural(attempt, 'attempt')} (${formatSeconds(now() - lostAt)})`,
        { lostBecause: lostReason });
      ui('onReconnecting', null);
    }
    phase = 'live';
    liveSince = now();

    // Once per attempt: an ICE blip goes disconnected and back to connected on the same one.
    if (monitoredGeneration === gen) return;
    stopWatching();
    monitoredGeneration = gen;
    const handle = current;
    stopMonitors = monitors.map((monitor) => monitor({
      settings,
      handle,
      reportLost: (lost) => {
        if (!active || gen !== generation || failedGeneration === gen) return;
        failed(lost);
      },
    })).filter((stop) => typeof stop === 'function');
  };

  const launch = () => {
    closeCurrent(false);
    const gen = ++generation;
    const isCurrent = () => active && gen === generation && failedGeneration !== gen;
    const settings = { ...context.settings, ...(context.readLive ? context.readLive() : {}) };

    // A replacement must be able to work with what it is given now, or it is better not made.
    const problem = phase === 'reconnecting' ? checkAttempt(settings) : null;
    if (problem) {
      logEvent('error', 'pc', `${role} stopped instead of starting ${words.attempt} ${attempt}: ${problem.reason}`, null);
      finish();
      ui('onFailed', problem.message);
      return;
    }
    const own = (context.makeCallbacks ? context.makeCallbacks() : null) || {};

    const callbacks = {};
    for (const [name, fn] of Object.entries(own)) {
      if (typeof fn === 'function') callbacks[name] = (...args) => (isCurrent() ? fn(...args) : undefined);
    }
    callbacks.onConnectionStateChange = (result) => {
      if (!isCurrent()) return;
      if (own.onConnectionStateChange) own.onConnectionStateChange(result);
      if (result && result.connected) connected(gen, settings);
    };
    callbacks.onError = (error) => {
      if (!isCurrent()) return;
      failed({
        reason: error?.message ?? String(error),
        message: error?.message ?? String(error),
        status: error?.status,
        unreachable: Boolean(error?.unreachable),
      });
    };
    callbacks.onSessionLost = (lost) => {
      if (!isCurrent()) return;
      failed(lost || {});
    };

    if (phase === 'reconnecting') {
      const limit = reconnectTiming('connectTimeoutMs', ATTEMPT_CONNECT_TIMEOUT_MS);
      connectTimer = setTimeout(() => {
        connectTimer = null;
        if (!isCurrent()) return;
        failed({ reason: `not connected after ${formatSeconds(limit)}` });
      }, limit);
    }

    const handle = startAttempt(settings, callbacks);
    // A first attempt that failed synchronously has already ended everything; its handle is spent.
    if (isCurrent()) current = handle;
    else if (handle && typeof handle.close === 'function') handle.close({ sendClose: false });
  };

  return {
    /**
     * Starts supervising. Does nothing while a session is already supervised, which is what
     * makes a second call (a StrictMode double effect, a remount) harmless.
     *
     * context: { settings, readLive(), makeCallbacks(), ui: { onReconnecting, onAttemptEnded, onFailed } }
     * settings is the snapshot taken at Start; readLive() adds what must be current on every
     * attempt (the tracks, which a camera switch replaces mid-session).
     */
    start: (nextContext) => {
      if (active) return false;
      context = nextContext;
      active = true;
      phase = 'starting';
      attempt = 0;
      launch();
      return true;
    },

    /** Ends the session, whatever it is doing: connecting, live, or waiting to reconnect. */
    stop: () => {
      if (!active) return false;
      if (phase === 'reconnecting')
        logEvent('info', 'pc', `${role} recovery canceled by Stop during attempt ${attempt} of ${MAX_RECONNECT_ATTEMPTS}`, null);
      finish();
      return true;
    },

    get active() { return active; },
    get phase() { return phase; },
    get attempt() { return attempt; },
  };
};
