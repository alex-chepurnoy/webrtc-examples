/*
 * What the publish and play attempts share for telling a lost session apart from a network
 * blip, and for ending one attempt cleanly so the session supervisor can start the next.
 *
 * An ICE restart repairs the network path and nothing else. When the Engine itself has lost
 * the session (an application or Engine restart), the socket closes, or an ICE restart is
 * refused or never answered, and only a new session helps. startPublish and startPlay report
 * those cases through onSessionLost; sessionSupervisor.js decides what to do about them.
 */

import { engineStatusFromCloseCode, logEvent } from '../diagnostics/signalLog';

/*
 * How long an ICE restart may wait for the Engine's answer. The page's own limit: the Engine
 * has a 15 s connectivity restart of its own, which is a different timer and is not this one.
 */
export const ICE_RESTART_ANSWER_TIMEOUT_MS = 8000;

// 425 is the Engine still busy with an earlier restart. Asked again after this, not given up on.
export const ICE_RESTART_BUSY_STATUS = 425;
export const ICE_RESTART_RETRY_MS = 2000;

/*
 * The panel text for a refused ICE restart. 400 is what a restart gets on a channel whose
 * session the Engine no longer holds (WebRTCSignalingHandler), which is the case this exists for.
 */
export const describeIceRestartStatus = (status, description) => {
  const text = typeof description === 'string' ? description.trim() : '';
  if (status === 400 && (text === '' || /no session/i.test(text)))
    return 'Engine has no session for this connection';
  if (text !== '') return text;
  if (status === 404) return 'Engine does not know this connection';
  if (status === 409) return 'Engine cannot restart ICE in the session\'s current state';
  if (status === 410) return 'Engine ended the session';
  return 'no reason given';
};

/** The reason and Engine status for a signaling socket that closed without being asked to. */
export const sessionLostFromClose = (event) => {
  const code = event?.code;
  const status = engineStatusFromCloseCode(code);
  if (status != null) {
    return {
      status,
      reason: `the Engine ended the session (status ${status}${event.reason ? `: ${event.reason}` : ''})`,
    };
  }
  return { status: null, reason: `signaling socket closed unexpectedly (code ${code})` };
};

/** One ICE-restart answer timer per attempt, kept on its session so every exit can clear it. */
export const armIceRestartTimeout = (session, onTimeout) => {
  clearIceRestartTimeout(session);
  session.iceRestartTimer = setTimeout(() => {
    session.iceRestartTimer = null;
    onTimeout();
  }, ICE_RESTART_ANSWER_TIMEOUT_MS);
};

export const clearIceRestartTimeout = (session) => {
  if (session.iceRestartTimer == null) return;
  clearTimeout(session.iceRestartTimer);
  session.iceRestartTimer = null;
};

export const logIceRestartUnanswered = (role) =>
  logEvent('warn', 'pc', `${role} ICE restart unanswered after ${ICE_RESTART_ANSWER_TIMEOUT_MS / 1000} s`,
    'This page gives the Engine this long to answer. It is separate from the Engine\'s own 15 s '
    + 'connectivity restart.');

/**
 * The same limit for a WHIP or WHEP restart, which is one HTTP exchange. Rejects with an
 * error carrying timedOut when the answer does not come in time.
 */
export const withIceRestartTimeout = (promise) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`ICE restart unanswered after ${ICE_RESTART_ANSWER_TIMEOUT_MS / 1000} s`);
      error.timedOut = true;
      reject(error);
    }, ICE_RESTART_ANSWER_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/*
 * The callbacks one attempt may use. Once the attempt has failed or been closed, nothing more
 * from it reaches the caller: a late event from a replaced connection must not change the
 * state of the one that replaced it. The first failure wins and tears the attempt down before
 * it is reported, so a failed attempt never leaves its peer connection running.
 */
export const guardAttemptCallbacks = (session, callbacks, tearDown) => {
  const source = callbacks || {};
  const live = () => !session.closed && !session.failed;
  const guarded = {};

  for (const [name, fn] of Object.entries(source)) {
    if (typeof fn !== 'function') continue;
    guarded[name] = (...args) => (live() ? fn(...args) : undefined);
  }

  const fail = (name) => (payload) => {
    if (!live()) return;
    session.failed = true;
    try {
      tearDown();
    } catch (error) {
      logEvent('error', 'pc', 'could not tear down the failed attempt', error?.message ?? String(error));
    }
    if (typeof source[name] === 'function') source[name](payload);
    // A caller with no reconnect logic still hears about the loss, as the error it used to be.
    else if (name === 'onSessionLost' && typeof source.onError === 'function')
      source.onError({ message: `Lost the session with the Engine: ${payload?.reason}`, status: payload?.status });
  };

  guarded.onError = fail('onError');
  guarded.onSessionLost = fail('onSessionLost');
  return guarded;
};
