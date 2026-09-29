// ICE restart recovery utilities, shared by the publish (startPublish.js) and play
// (startPlay.js) flows.
//
// When the network path changes (NAT rebinding, interface switch, Wi-Fi/cellular handoff)
// the ICE connection drops to "disconnected" or "failed". restartIce() flags the next
// negotiation for fresh ICE credentials and fires onnegotiationneeded, which re-sends an
// OFFER over the existing connection so the session recovers without being torn down and
// re-established.

const ICE_RESTART_GRACE_PERIOD_MS = 3000;

// Peer connections owing a re-offer. Module-level so requesters and onnegotiationneeded handlers
// reach it without the recovery handle.
const pendingRestartOffers = new WeakSet();

const markRestartRequested = (peerConnection) => pendingRestartOffers.add(peerConnection);

// Peer connections whose last negotiationneeded was dropped by the gate below. The browser
// raises the event only when its negotiation-needed flag goes from false to true, and a
// dropped one leaves the flag up: a restart offer rolled back after a 425 is still owed, so
// the browser re-raises negotiationneeded at once, the gate drops it (nothing was pending
// yet), and every restartIce() after that raises nothing at all.
const droppedNegotiations = new WeakSet();

// Every onnegotiationneeded handler must gate its re-offer on this: the browser re-raises
// negotiationneeded on every return to "stable" and answering those renegotiates forever.
export const consumeIceRestartOffer = (peerConnection) => {
  if (!peerConnection || !pendingRestartOffers.has(peerConnection)) {
    if (peerConnection) droppedNegotiations.add(peerConnection);
    console.log('negotiationneeded raised without a pending ICE restart: no re-offer sent.');
    return false;
  }
  pendingRestartOffers.delete(peerConnection);
  droppedNegotiations.delete(peerConnection);
  return true;
};

// Asks for a restart offer. Where the browser will not raise negotiationneeded again (see
// droppedNegotiations), the handler is called here instead, once the browser has had its
// chance: whichever comes first consumes the pending restart and the other is dropped.
const raiseIceRestart = (peerConnection) => {
  markRestartRequested(peerConnection);
  peerConnection.restartIce();
  if (!droppedNegotiations.has(peerConnection)) return;
  setTimeout(() => {
    if (!pendingRestartOffers.has(peerConnection)) return;
    if (peerConnection.signalingState !== 'stable') return;
    if (typeof peerConnection.onnegotiationneeded === 'function')
      peerConnection.onnegotiationneeded(new Event('negotiationneeded'));
  }, 0);
};

// Attaches an oniceconnectionstatechange handler that requests an ICE restart when the
// connection drops, automatically recovering the session in place.
//
// This only ever fixes the network path. When the Engine has lost the session itself (an
// application restart, an Engine restart) no ICE restart can help, and the session
// supervisor (sessionSupervisor.js) replaces the whole connection instead; it reads
// isRestartInProgress() and hasRestartBeenAnswered() from here to tell the two apart.
export const attachIceRestartRecovery = (peerConnection) => {
  let iceRestartGraceTimer = null;
  let retryTimer = null;
  let iceRestartInProgress = false;
  let restartAnswered = false;
  let disposed = false;

  const clearTimers = () => {
    if (iceRestartGraceTimer) { clearTimeout(iceRestartGraceTimer); iceRestartGraceTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  };

  const requestIceRestart = (reason) => {
    if (disposed) return;
    if (iceRestartInProgress) return; // one restart at a time; the engine rejects concurrent restarts
    if (typeof peerConnection.restartIce !== 'function') {
      console.warn('ICE restart needed but restartIce() is not supported in this browser.');
      return;
    }
    iceRestartInProgress = true;
    console.log(`Requesting ICE restart (${reason}).`);
    raiseIceRestart(peerConnection);
  };

  const handler = () => {
    if (disposed) return;
    const iceState = peerConnection.iceConnectionState;
    console.log(`ICE connection state: ${iceState}`);

    switch (iceState) {
      case 'failed':
        // Hard failure - recover immediately.
        if (iceRestartGraceTimer) { clearTimeout(iceRestartGraceTimer); iceRestartGraceTimer = null; }
        requestIceRestart('iceConnectionState=failed');
        break;
      case 'disconnected':
        // Often transient - give it a moment to self-heal before forcing a restart.
        if (!iceRestartGraceTimer && !iceRestartInProgress) {
          iceRestartGraceTimer = setTimeout(() => {
            iceRestartGraceTimer = null;
            const current = peerConnection.iceConnectionState;
            if (current === 'disconnected' || current === 'failed') {
              requestIceRestart(`iceConnectionState=${current} after grace period`);
            }
          }, ICE_RESTART_GRACE_PERIOD_MS);
        }
        break;
      case 'connected':
      case 'completed':
        // Recovered (or initial connect): clear pending work and re-arm for the next change.
        clearTimers();
        iceRestartInProgress = false;
        restartAnswered = false;
        break;
      default:
        // 'new' / 'checking' / 'closed' - no recovery action needed; log just in case.
        console.log(`ICE connection state ${iceState}: no ICE-restart action taken.`);
        break;
    }
  };
  peerConnection.oniceconnectionstatechange = handler;

  return {
    // For transports that drive the restart from outside this module (WHIP/WHEP renegotiate via
    // onnegotiationneeded): if that restart attempt fails, ICE stays failed/disconnected and no
    // further state-change event fires, so the "one restart at a time" guard would block every
    // retry forever. notifyRestartFailed() clears the guard so a later transition can try again.
    notifyRestartFailed: () => { iceRestartInProgress = false; },
    // The Engine answered 425: it is still busy with a restart of its own. Not a lost session,
    // so the same restart is asked for again once it has had time to finish.
    retryRestart: (delayMs, reason) => {
      iceRestartInProgress = false;
      if (disposed || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        const current = peerConnection.iceConnectionState;
        if (current === 'disconnected' || current === 'failed') requestIceRestart(reason);
      }, delayMs);
    },
    isRestartInProgress: () => iceRestartInProgress,
    // The Engine answered a restart. If the connection still fails after that, the restart
    // did not work and the session is gone rather than the path; ICE connecting again clears it.
    notifyRestartAnswered: () => { restartAnswered = true; },
    hasRestartBeenAnswered: () => restartAnswered,
    // A replaced connection must not go on requesting restarts, or restart timers firing into
    // a closed connection, after the session has moved on.
    dispose: () => {
      disposed = true;
      clearTimers();
      if (peerConnection.oniceconnectionstatechange === handler)
        peerConnection.oniceconnectionstatechange = null;
    },
  };
};

// Test aid: manually trigger an ICE restart on an active peer connection. restartIce()
// flags the next negotiation for fresh ICE credentials and fires onnegotiationneeded,
// which the signaling flow handles by re-sending an OFFER with a new ufrag/pwd over the
// same connectionId. The engine detects the credential change and renegotiates ICE
// without recreating the session.
export const triggerIceRestart = (peerConnection) => {
  if (peerConnection && typeof peerConnection.restartIce === 'function') {
    console.log('[ICE restart] Calling peerConnection.restartIce(); a new offer with fresh ICE credentials will be sent.');
    // Arms the gate, else the negotiationneeded this raises is dropped and nothing reaches the engine.
    raiseIceRestart(peerConnection);
  } else {
    console.warn('[ICE restart] No active peer connection, or restartIce() is unsupported in this browser.');
  }
};
