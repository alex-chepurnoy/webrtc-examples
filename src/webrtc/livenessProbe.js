/*
 * The one signal an application restart gives a publisher: none. The Engine drops the
 * stream, but the WebRTC connection under it (ICE, DTLS, the signaling socket) stays up, so
 * the page reads LIVE with nothing behind it. This asks the Engine, on its own short-lived
 * socket, whether the stream is still there.
 *
 * Its own socket because a reply on the session channel carries no request id, and any
 * status other than 200 there ends the session. What it keys on:
 *   - the stream missing from the list twice in a row: the session is lost;
 *   - 404: the application no longer exists, so no republish can work and none is tried
 *     (asking for an application loads it, so 404 is not a restart in progress);
 *   - 400 or 403: this Engine does not answer the question (stream query or WebSocket
 *     signaling is off). The check stops, with one warning, and the publish goes on;
 *   - no answer at all: says nothing about the session, which the socket and ICE report.
 *
 * It never runs while an ICE restart is out, since the answer to that is already coming.
 */

import { logEvent } from '../diagnostics/signalLog';
import { LOOKUP_ERROR, LOOKUP_OK, listAvailableStreams, signalingLookupUrl } from '../utils/RenditionUtils';
import { reconnectTiming, withJitter } from './sessionSupervisor';

export const LIVENESS_PROBE_INTERVAL_MS = 20000;
// After LIVE, so the Engine has had time to list a stream that just started.
export const LIVENESS_PROBE_GRACE_MS = 15000;
// A miss is checked again sooner than the interval: one miss proves nothing, and waiting a full
// interval for the second would leave a dead publish showing LIVE for most of a minute.
export const LIVENESS_PROBE_RECHECK_MS = 5000;
export const LIVENESS_MISSES_FOR_LOSS = 2;

// v2 so the answer comes from the same implementation as the session. wzProbe marks the
// socket as this check's, which is how a test tells it from the session socket.
export const LIVENESS_PROBE_QUERY = 'webrtcImplementation=v2&wzProbe=liveness';

export const livenessProbeUrl = (signalingURL) => {
  const base = signalingLookupUrl(signalingURL);
  if (!base) return null;
  return `${base}${base.includes('?') ? '&' : '?'}${LIVENESS_PROBE_QUERY}`;
};

/**
 * Starts checking. Returns the function that stops it.
 * onLost({ reason, terminal? }) is called at most once.
 */
export const startLivenessProbe = ({
  role = 'publish',
  signalingURL,
  applicationName,
  streamName,
  isIceRestartInProgress,
  onLost,
  list = listAvailableStreams,
  random = Math.random,
}) => {
  const url = livenessProbeUrl(signalingURL);
  if (!url || !applicationName || !streamName) {
    logEvent('warn', 'ws', `${role} liveness check off: no signaling address to ask`,
      'An application restart will not be noticed.');
    return () => {};
  }

  const interval = reconnectTiming('probeIntervalMs', LIVENESS_PROBE_INTERVAL_MS);
  const recheck = reconnectTiming('probeRecheckMs', LIVENESS_PROBE_RECHECK_MS);
  const grace = reconnectTiming('probeGraceMs', LIVENESS_PROBE_GRACE_MS);

  let stopped = false;
  let timer = null;
  let misses = 0;
  let confirmed = false;

  const next = (ms) => {
    if (stopped) return;
    timer = setTimeout(tick, withJitter(ms, random));
  };

  const lost = (info) => {
    stopped = true;
    onLost(info);
  };

  async function tick() {
    timer = null;
    if (stopped) return;
    if (isIceRestartInProgress && isIceRestartInProgress()) { next(interval); return; }

    let result;
    try {
      result = await list(url, applicationName);
    } catch {
      result = null;
    }
    if (stopped) return;

    if (result && result.status === LOOKUP_OK) {
      if (result.streams.includes(streamName)) {
        misses = 0;
        if (!confirmed) {
          confirmed = true;
          logEvent('info', 'ws',
            `${role} liveness check: stream "${streamName}" is live on the Engine, checking every ${Math.round(interval / 1000)} s`, null);
        }
        next(interval);
        return;
      }
      misses += 1;
      if (misses < LIVENESS_MISSES_FOR_LOSS) {
        logEvent('warn', 'ws',
          `${role} stream "${streamName}" not listed by application "${applicationName}" (${misses} of ${LIVENESS_MISSES_FOR_LOSS}), checking again`,
          { availableStreams: result.streams });
        next(recheck);
        return;
      }
      logEvent('error', 'ws',
        `${role} stream "${streamName}" no longer on the Engine (application "${applicationName}" did not list it ${LIVENESS_MISSES_FOR_LOSS} times in a row)`,
        { availableStreams: result.streams });
      lost({ reason: `stream "${streamName}" no longer on the Engine` });
      return;
    }

    if (result && result.status === LOOKUP_ERROR && result.code === 404) {
      logEvent('error', 'ws',
        `${role} stream "${streamName}" no longer on the Engine (application "${applicationName}" returned 404)`,
        result.message || null);
      lost({ reason: `application "${applicationName}" returned 404`, terminal: true });
      return;
    }

    if (result && result.status === LOOKUP_ERROR && (result.code === 400 || result.code === 403)) {
      stopped = true;
      logEvent('warn', 'ws',
        `${role} liveness check off: the Engine refused it (${result.code}${result.message ? `: ${result.message}` : ''})`,
        'An application restart will not be noticed. The publish itself is not affected.');
      return;
    }

    // Unreachable, or an answer this cannot read: not evidence either way.
    next(interval);
  }

  next(grace);

  return () => {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
  };
};
