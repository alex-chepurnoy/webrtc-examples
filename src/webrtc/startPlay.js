import { keepUntilStopped, releaseSessionHandles } from './sessionHandles';
import { releasePeerConnection } from '../diagnostics/connections';
import { describeSignalingError, instrumentPeerConnection, instrumentWebSocket, isWebSocketClosing, logEvent, loggedFetch, markWebSocketClosing, redactSecrets, sendSignal } from '../diagnostics/signalLog';
import getSecureToken from './SecureToken';
import { validateParams } from '../utils/ValidationUtils';
import { addIceServers } from '../utils/IceServersUtils';
import { attachIceRestartRecovery, consumeIceRestartOffer } from '../utils/IceRestartUtils';
import { sendWhipWhepIceRestart } from '../utils/SdpFragUtils';
import {
  armAnswerTimeout,
  clearAnswerTimeout,
  getAnswerTimeoutMessage,
  getWhipWhepFailureMessage
} from '../utils/NegotiationFailureUtils';
import attachDataChannel, {
  CHAT_CHANNEL_LABEL,
  CAPTIONS_CHANNEL_LABEL,
  createSctpBootstrap,
  dataChannelsAcceptedInAnswer,
  ensureApplicationSectionInAnswer,
} from './attachDataChannel';
import {
  attachClockInitiator,
  configureEncodedStreams,
  passThroughEncodedFrames,
  probeUnavailableReason,
  startReceiverProbe,
} from '../diagnostics/latencyProbe';
import {
  ICE_RESTART_BUSY_STATUS,
  armIceRestartTimeout,
  clearBusyIceRestarts,
  clearIceRestartTimeout,
  describeIceRestartStatus,
  guardAttemptCallbacks,
  logIceRestartUnanswered,
  retryBusyIceRestart,
  sessionLostFromClose,
  withIceRestartTimeout,
} from './sessionLoss';

// Listen for whichever data channels are enabled on the player: chat (full-duplex) and/or captions
// (one-way, receive here). The bootstrap must come first, whenever any channel is enabled, so the
// SCTP transport is negotiated in the offer and WSE can open the mirrored channels. Returns a handle
// to close them if the server refuses the SCTP section.
const attachPlayDataChannels = (peerConnection, callbacks, playSettings) => {
  if (!playSettings.chatEnabled && !playSettings.captionsEnabled && !playSettings.latencyProbe)
    return null;
  const channels = [createSctpBootstrap(peerConnection)];
  if (playSettings.chatEnabled)
    channels.push(attachDataChannel(peerConnection, callbacks, { label: CHAT_CHANNEL_LABEL, create: false }));
  if (playSettings.captionsEnabled)
    channels.push(attachDataChannel(peerConnection, callbacks, { label: CAPTIONS_CHANNEL_LABEL, create: false }));
  // The probe's clock channel. The player asks, because the frame send times are on the
  // publisher's clock; it needs the bootstrap above like the other channels.
  if (playSettings.latencyProbe)
    channels.push(attachClockInitiator(peerConnection));
  return { close: () => channels.forEach((channel) => channel.close()) };
};

// encodedInsertableStreams can only be set at RTCPeerConnection construction, so this runs
// before one exists, and logs why if the probe cannot run.
const armEncodedStreams = (session, playSettings) => {
  if (!playSettings.latencyProbe) return;
  if (!configureEncodedStreams(session.peerConnectionConfig, true))
    logEvent('error', 'pc', 'latency probe unavailable', probeUnavailableReason());
};

// The SCTP section shares the offer/answer with media but is optional: give up on the channels, tell
// the UI, leave the session alone. Returns the handle to keep - null once refused, so a later
// ICE-restart answer doesn't report it twice.
const handleRefusedDataChannels = (answerSdp, dataChannels, callbacks) => {
  if (!dataChannels || dataChannelsAcceptedInAnswer(answerSdp)) return dataChannels;
  console.log('Data channels were refused by the server; continuing with media only.');
  dataChannels.close();
  if (callbacks.onDataChannelsUnavailable)
    callbacks.onDataChannelsUnavailable();
  return null;
};

const getAuthHeaders = (authToken) =>
  authToken ? { "Authorization": `Bearer ${authToken}` } : {};

// Everything one play attempt opened, closed in one place (see tearDownAttempt in
// startPublish.js). Every exit comes here: a failure through guardAttemptCallbacks, a
// deliberate stop or a replacement through the handle startPlay returns.
//
// sendClose asks the Engine to drop the session first, with CLOSE on a socket still open. A
// WHEP resource is always DELETEd, as the Stop button always did.
const tearDownPlayAttempt = (session, playSettings, { sendClose = false } = {}) => {
  if (session.tornDown) return;
  session.tornDown = true;

  clearAnswerTimeout(session);
  clearIceRestartTimeout(session);
  if (session.repeaterTimer) { clearTimeout(session.repeaterTimer); session.repeaterTimer = null; }
  if (session.recovery) session.recovery.dispose();

  const { peerConnection, websocket } = session;
  // Only this attempt's connection, so a late teardown cannot deregister a newer one.
  releasePeerConnection('play', peerConnection);
  if (websocket) markWebSocketClosing(websocket);
  releaseSessionHandles(peerConnection);
  if (peerConnection) {
    peerConnection.onicecandidate = null;
    peerConnection.onnegotiationneeded = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.ontrack = null;
    try { peerConnection.close(); } catch { /* already closed */ }
  }

  if (session.whepSessionUrl) {
    const sessionUrl = session.whepSessionUrl;
    session.whepSessionUrl = null;
    // Logged like every other HTTP exchange: the DELETE that ends a WHEP session was the
    // only one missing from the panel, which made a session look like it never ended.
    loggedFetch(sessionUrl, { method: "DELETE", headers: getAuthHeaders(playSettings.authToken) })
      .catch(() => {});
  }

  if (websocket) {
    if (sendClose && websocket.readyState === WebSocket.OPEN && session.sessionId !== '[empty]') {
      sendSignal(websocket, 'play', {
        messageType: "CLOSE",
        action: "VIEW",
        applicationName: playSettings.applicationName,
        streamName: playSettings.streamName,
        connectionId: session.sessionId,
      });
    }
    try { websocket.close(); } catch { /* already closed or closing */ }
  }
};

// connected tells the page media can flow. failed after the Engine answered an ICE restart is
// the restart not working, so the session is gone rather than the path.
const reportConnectionState = (state, callbacks, session) => {
  if (callbacks.onConnectionStateChange)
    callbacks.onConnectionStateChange({ connected: state === 'connected', state });
  if (state === 'failed' && session.recovery && session.recovery.hasRestartBeenAnswered())
    callbacks.onSessionLost({ reason: 'connection failed after an ICE restart' });
};

// The status that answers an ICE restart; see the same function in startPublish.js.
const handleIceRestartStatus = (status, description, callbacks, session) => {
  clearIceRestartTimeout(session);
  session.iceRestartPending = false;
  if (status === ICE_RESTART_BUSY_STATUS) {
    retryBusyIceRestart({
      label: 'play status 425 to ICE_RESTART', channel: 'ws',
      peerConnection: session.peerConnection, session, callbacks, description,
    });
    return;
  }
  logEvent('error', 'ws',
    `play status ${status} to ICE_RESTART: ${describeIceRestartStatus(status, description)}`,
    description || null);
  if (session.recovery) session.recovery.notifyRestartFailed();
  callbacks.onSessionLost({ reason: `ICE_RESTART answered ${status}`, status });
};


// Utilities



const getStreamInfo = (playSettings, session) => {

  return {
    applicationName:playSettings.applicationName,
    streamName:playSettings.streamName,
    sessionId: session.sessionId
  };
}

const getSecureTokenData = (playSettings) => {
  // Only return secure token data if secret is provided
  if (!playSettings.secret) {
    return null;
  }

  return {
    secret: playSettings.secret,
    timeout: playSettings.timeout ? parseInt(playSettings.timeout) : 0,
    prefix: playSettings.prefix || 'wowzatoken',
    isIp: playSettings.isIp || false,
    ip: playSettings.ip || '',
    applicationName: playSettings.applicationName,
    streamName: playSettings.streamName
  };
}

// PeerConnection Functions

const peerConnectionOnError = (error, callbacks) => {
  // Not console.log(error); see websocketOnError. An Event carries no message.
  const message = describeSignalingError(error);
  logEvent('error', 'pc', 'play peer connection failed', message);
  if (callbacks.onError)
    callbacks.onError({message:'PeerConnection Error: '+message});
}


// Websocket Functions

const websocketOnOpen = async (playSettings, websocket, callbacks, session) => {

  let peerConnection;
  const pendingCandidates = [];
  const secureTokenData = getSecureTokenData(playSettings);
  const secureToken = await getSecureToken(secureTokenData);
  
  try {
    addIceServers(playSettings, session);
    armEncodedStreams(session, playSettings);
    peerConnection = new RTCPeerConnection(session.peerConnectionConfig);
    session.peerConnection = peerConnection;
    instrumentPeerConnection(peerConnection, 'play');
    peerConnection.addTransceiver('video', { direction: 'recvonly' });
    peerConnection.addTransceiver('audio', { direction: 'recvonly' });
    peerConnection.ontrack = (event) => {
      // The stamp is read before decode. Attached in ontrack because a receiver's encoded
      // stream can be taken only once. startReceiverProbe cannot throw into this handler.
      if (playSettings.latencyProbe && event.track.kind === 'video')
        keepUntilStopped(peerConnection, startReceiverProbe(event.receiver));
      // encodedInsertableStreams covers the whole connection, so audio frames must be passed on.
      if (playSettings.latencyProbe && event.track.kind !== 'video')
        keepUntilStopped(peerConnection,
          passThroughEncodedFrames(event.receiver, 'play audio receiver'));
      if (callbacks.onPeerConnectionOnTrack)
        callbacks.onPeerConnectionOnTrack(event);
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        const candidatePayload = {
          messageType: "CANDIDATE",
          action: "VIEW",
          applicationName: playSettings.applicationName,
          streamName: playSettings.streamName,
          connectionId: session.sessionId,
          candidate: event.candidate.candidate,
        };

        if (secureToken) {
          candidatePayload.secureToken = secureToken;
        }

        if (session.sessionId === '[empty]') {
          pendingCandidates.push(candidatePayload);
        } else {
          console.log('Sending ICE candidate:', JSON.stringify(redactSecrets(candidatePayload)));
          sendSignal(websocket, 'play', candidatePayload);
        }
      } else {
        const endOfCandidatesPayload = {
          messageType: "CANDIDATE",
          action: "VIEW",
          applicationName: playSettings.applicationName,
          streamName: playSettings.streamName,
          connectionId: session.sessionId,
          candidate: ""
        };
        if (session.sessionId === '[empty]') {
          pendingCandidates.push(endOfCandidatesPayload);
        } else {
          console.log('Sending end of candidates:', JSON.stringify(redactSecrets(endOfCandidatesPayload)));
          sendSignal(websocket, 'play', endOfCandidatesPayload);
        }
      }
    };

    peerConnection.onconnectionstatechange = (event) => {
      reportConnectionState(event.currentTarget.connectionState, callbacks, session);
    }

    peerConnection.onnegotiationneeded = () => {
      // Initial play offer is sent explicitly below, before a connectionId exists; otherwise only
      // for a restart we asked for.
      if (session.sessionId === '[empty]' || !consumeIceRestartOffer(peerConnection)) return;
      console.log('onnegotiationneeded: sending ICE_RESTART offer over the existing connection.');
      websocketSendPlayGetOffer(playSettings, websocket, peerConnection, callbacks, session);
    };

    // ICE restart recovery: re-establishes the ICE connection in place when the network
    // path changes, without tearing down the play session. See IceRestartUtils.
    session.recovery = attachIceRestartRecovery(peerConnection);

    // The data channels must be listened for before the first offer (we never renegotiate). WSE
    // opens the mirrored channels toward the player; the player writes back on chat.
    // The clock channel rides in here, so closing this is what stops its timer chain.
    session.dataChannels = keepUntilStopped(
      peerConnection, attachPlayDataChannels(peerConnection, callbacks, playSettings));

    websocket.addEventListener("message", (event) => { websocketOnMessage(event, playSettings, peerConnection, websocket, callbacks, session, pendingCandidates); });

    websocketSendPlayGetOffer(playSettings, websocket, peerConnection, callbacks, session);

  }
  catch (e) {
    websocketOnError(e, callbacks);
  }
  if (callbacks.onSetPeerConnection)
    callbacks.onSetPeerConnection({peerConnection:peerConnection});
}

const websocketOnMessage = (event, playSettings, peerConnection, websocket, callbacks, session, pendingCandidates) => {

  let msgJSON = JSON.parse(event.data);
  console.log(`Websocket Response: ${JSON.stringify(redactSecrets(msgJSON))}`);

  if (msgJSON.messageType?.toLowerCase() === "candidate") {
    peerConnection.addIceCandidate(new RTCIceCandidate({ candidate: msgJSON.candidate, sdpMLineIndex: 0 }));
    return;
  }

  // Any status reply means the engine saw the offer; only silence is a timeout. The repeater
  // retry below re-sends the offer and re-arms it.
  clearAnswerTimeout(session);

  let msgStatus = Number(msgJSON['statusCode']);
  console.log(`Status: ${msgStatus}`);

  if (msgStatus !== 200 && session.iceRestartPending) {
    handleIceRestartStatus(msgStatus, msgJSON['statusDescription'], callbacks, session);

  } else if (msgStatus === 514 || msgStatus === 504) {
    session.repeaterRetryCount++;

    if (session.repeaterRetryCount < 10) {
      // On the session, so a stop or a replacement cancels the retry rather than letting it
      // send an offer on a closed socket.
      session.repeaterTimer = setTimeout(() => {
        session.repeaterTimer = null;
        if (session.closed || session.failed) return;
        websocketSendPlayGetOffer(playSettings, websocket, peerConnection, callbacks, session);
      }, 1000);
    } else {
      // The guard around the callbacks tears the attempt down.
      websocketOnError({message:'Live stream repeater timeout: ' + playSettings.streamName, status: msgStatus}, callbacks);
    }

  } else if (msgStatus !== 200) {

    websocketOnError({message:msgJSON['statusDescription'], status: msgStatus}, callbacks);

  } else {
    if (msgJSON.message) {
      const message = msgJSON.message;
      if (message.connectionId) {
        session.sessionId = message.connectionId;

        for (const candidate of pendingCandidates) {
          candidate.connectionId = session.sessionId;
          console.log('Sending queued ICE candidate:', JSON.stringify(redactSecrets(candidate)));
          sendSignal(websocket, 'play', candidate);
        }
        pendingCandidates.length = 0;
      }
      if (message.sdp && session.iceRestartPending) {
        // The Engine took the restart. If the connection fails even so, the session is gone.
        clearIceRestartTimeout(session);
        session.iceRestartPending = false;
        if (session.recovery) session.recovery.notifyRestartAnswered();
        clearBusyIceRestarts(session);
      }
      if (message.sdp) {
        console.log("SDP Data: " + message.sdp);
        let sdpData = {
          "sdp" : ensureApplicationSectionInAnswer(peerConnection.localDescription.sdp, message.sdp),
          "type": "answer"
        }
        peerConnection
          .setRemoteDescription(new RTCSessionDescription(sdpData))
          .then(() => {
            // Initial offer/answer is complete; from here a re-offer is an ICE restart.
            session.negotiationEstablished = true;
            console.log("Remote Description Set Successfully.");
            session.dataChannels = handleRefusedDataChannels(sdpData.sdp, session.dataChannels, callbacks);
          })
          .catch((err) => peerConnectionOnError(err, callbacks));
      }
    }
  }
}

// extra is merged into the report: unreachable marks a socket that never opened, which
// the supervisor waits out during an Engine restart instead of counting as a failed attempt.
const websocketOnError = (error, callbacks, extra = {}) => {
  /*
   * Not console.log(error): the event references the socket and window, and the console keeps
   * that whole graph alive for expansion. The event also has no .message.
   */
  const message = describeSignalingError(error);
  logEvent('error', 'ws', 'play signalling failed', message);
  if (callbacks.onError)
    callbacks.onError({message:'Websocket Error: '+message, status: error?.status, ...extra});
}

const createOfferPayload = (playSettings, session, secureToken = null) => {
  const streamInfo = getStreamInfo(playSettings, session);
  // After the initial negotiation a re-offer is an ICE restart: signal ICE_RESTART carrying the full offer
  // SDP (the engine normalizes it to a trickle-ice-sdpfrag). A plain OFFER restart is no longer auto-detected.
  const offerPayload = {
      messageType: session.negotiationEstablished ? "ICE_RESTART" : "OFFER",
      action: "VIEW",
      applicationName: streamInfo.applicationName,
      streamName: streamInfo.streamName,
      connectionId: streamInfo.sessionId,
      // userData: getUserData(playSettings), Do we need this?
    };
    if (secureToken) {
      offerPayload.secureToken = secureToken;
    }
    return offerPayload;
}

const websocketSendPlayGetOffer = async (playSettings, websocket, peerConnection, callbacks, session) => {
  try {
    const secureTokenData = getSecureTokenData(playSettings);
    const secureToken = await getSecureToken(secureTokenData);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    console.log('Local SDP:', peerConnection.localDescription.sdp);

    const offerPayload = createOfferPayload(playSettings, session, secureToken);
    offerPayload.sdp = peerConnection.localDescription.sdp;

    console.log("sendPlayGetOffer: " + JSON.stringify(redactSecrets(offerPayload)));
    const restart = offerPayload.messageType === "ICE_RESTART";

    // A frame given to a socket that is not open goes nowhere. A restart that cannot be sent
    // means the signaling channel, and with it the session, is already gone.
    if (!sendSignal(websocket, 'play', offerPayload)) {
      if (restart) {
        if (session.recovery) session.recovery.notifyRestartFailed();
        callbacks.onSessionLost({ reason: 'ICE_RESTART not sent: the signaling socket is not open' });
      } else if (callbacks.onError) {
        callbacks.onError({ message: 'Websocket Error: the offer could not be sent, the socket is not open.' });
      }
      return;
    }

    if (restart) {
      // Without a limit an unanswered restart holds the restart guard up for good.
      session.iceRestartPending = true;
      armIceRestartTimeout(session, () => {
        session.iceRestartPending = false;
        logIceRestartUnanswered('play');
        if (session.recovery) session.recovery.notifyRestartFailed();
        callbacks.onSessionLost({ reason: 'ICE restart unanswered after 8 s' });
      });
    }

    // An engine that doesn't understand the offer (see NegotiationFailureUtils) never replies, so
    // without this the page would sit in "starting" forever. Only the initial offer is guarded: an
    // ICE restart has the timer above.
    if (offerPayload.messageType === "OFFER") {
      armAnswerTimeout(session, () => {
        // Something else already ended this attempt (a Stop, an error) if the socket is gone.
        if (websocket.readyState !== WebSocket.OPEN) return;
        if (callbacks.onError)
          callbacks.onError({ message: getAnswerTimeoutMessage(playSettings) });
      });
    }
  } catch (error) {
    console.error('Error generating secure token:', error);
    if (callbacks.onError) {
      callbacks.onError({ message: 'Failed to generate secure token: ' + error.message });
    }
  }
}

// startPlay
// callbacks:
// - onError({message:'', status?}): the attempt failed and has already been torn down
// - onSessionLost({reason, status?}): the Engine no longer holds the session (sessionLoss.js)
// - onPeerConnectionOnTrack({event:obj})
// - onConnectionStateChange({connected:boolean, state:string})
// - onSetPeerConnection({peerConnection:obj})
// - onSetWebsocket({websocket:obj})
//
// Returns a handle on this one attempt, for the session supervisor:
// - close({sendClose}): end it on purpose; nothing from it reaches the callbacks afterwards
// - isIceRestartInProgress(): an ICE restart is out and not yet answered or given up on
// - peerConnection: this attempt's connection, once there is one

const startPlay = (playSettings, callbacks) =>
{
  const session = {
    sessionId: '[empty]',
    repeaterRetryCount: 0,
    // false until the initial offer/answer completes; afterwards a re-offer is an ICE restart.
    negotiationEstablished: false,
    // handle to the enabled data channels, cleared once the server refuses them.
    dataChannels: null,
    // pending timer waiting for the answer to the initial offer, see NegotiationFailureUtils.
    answerTimeout: null,
    peerConnectionConfig: {iceServers: []},
    // What this attempt opened, so that one teardown can close all of it.
    peerConnection: null,
    websocket: null,
    socketOpened: false,
    whepSessionUrl: null,
    recovery: null,
    repeaterTimer: null,
    // An ICE restart is out and its answer timer is running (sessionLoss.js).
    iceRestartPending: false,
    iceRestartTimer: null,
    // closed: ended on purpose. failed: ended by a failure that has been reported.
    closed: false,
    failed: false,
    tornDown: false
  };

  const tearDown = (options) => tearDownPlayAttempt(session, playSettings, options);
  callbacks = guardAttemptCallbacks(session, callbacks, () => tearDown({ sendClose: true }));

  const handle = {
    close: ({ sendClose = false } = {}) => {
      if (session.closed) return;
      session.closed = true;
      tearDown({ sendClose });
    },
    isIceRestartInProgress: () => Boolean(
      session.iceRestartPending || (session.recovery && session.recovery.isRestartInProgress())),
    get peerConnection() { return session.peerConnection; },
  };

  try {
    validateParams(playSettings);

    if (playSettings.useWhep)
    {
      startPlayWhep(playSettings, session, callbacks);
    } else {

      const websocket = instrumentWebSocket(new WebSocket (playSettings.signalingURL + "?webrtcImplementation=v2"), 'play');

      if (websocket != null)
      {
        session.websocket = websocket;
        websocket.binaryType = 'arraybuffer';

        websocket.addEventListener ("open", () => {
          session.socketOpened = true;
          websocketOnOpen(playSettings, websocket, callbacks, session);
        });
        websocket.addEventListener ("error", (error) => {
          clearAnswerTimeout(session);
          // Errors that arrive because we are shutting down are not failures to report.
          if (isWebSocketClosing(websocket)) return;
          // Once the socket was open, the close event that always follows an error says more
          // (it has the code), so the loss is reported from there.
          if (session.socketOpened) return;
          websocketOnError(error, callbacks, { unreachable: true });
        });

        // The Engine going away, or ending the session with its status on the close frame.
        websocket.addEventListener ("close", (event) => {
          if (isWebSocketClosing(websocket)) return;
          if (!session.socketOpened) {
            websocketOnError(null, callbacks, { unreachable: true });
            return;
          }
          callbacks.onSessionLost(sessionLostFromClose(event));
        });

        if (callbacks.onSetWebsocket)
          callbacks.onSetWebsocket({websocket:websocket});
      }
    }
  }
  catch (e)
  {
    if (callbacks.onError)
      callbacks.onError(e);
  }

  return handle;
}

// A WHEP ICE restart is one PATCH; see restartIceOverWhip in startPublish.js for the reading
// of each outcome.
const restartIceOverWhep = (peerConnection, sessionUrl, playSettings, session, callbacks) => {
  session.iceRestartPending = true;
  withIceRestartTimeout(sendWhipWhepIceRestart(peerConnection, sessionUrl, {
    authHeaders: getAuthHeaders(playSettings.authToken),
    label: "WHEP",
  }))
    .then(() => {
      session.iceRestartPending = false;
      clearBusyIceRestarts(session);
      if (session.recovery) session.recovery.notifyRestartAnswered();
    })
    .catch((e) => {
      session.iceRestartPending = false;
      if (session.closed || session.failed) return;
      if (e && e.status === ICE_RESTART_BUSY_STATUS) {
        retryBusyIceRestart({
          label: 'WHEP ICE restart answered 425', channel: 'http',
          peerConnection, session, callbacks, description: e.description,
        });
        return;
      }
      if (session.recovery) session.recovery.notifyRestartFailed();
      if (e && e.timedOut) {
        logIceRestartUnanswered('play');
        callbacks.onSessionLost({ reason: 'ICE restart unanswered after 8 s' });
      } else if (e && e.status) {
        // sendWhipWhepIceRestart has logged the status and the Engine's description.
        callbacks.onSessionLost({ reason: `WHEP ICE restart rejected (${e.status})`, status: e.status });
      } else {
        const message = e?.message ?? String(e);
        logEvent('error', 'http', `WHEP ICE restart failed: ${message}`, null);
        callbacks.onSessionLost({ reason: `WHEP ICE restart failed: ${message}` });
      }
    });
};

const startPlayWhep = async (playSettings, session, callbacks) => {
  let peerConnection;
  let sessionUrl;
  let negotiationEstablished = false; // gate onnegotiationneeded so only ICE restarts (not the initial offer) re-offer
  const pendingCandidates = [];

  try {
    addIceServers(playSettings, session);
    armEncodedStreams(session, playSettings);
    peerConnection = new RTCPeerConnection(session.peerConnectionConfig);
    session.peerConnection = peerConnection;
    instrumentPeerConnection(peerConnection, 'play');

    // Hand it over immediately, as the WebSocket path does, so the store has it while negotiating.
    if (callbacks.onSetPeerConnection)
      callbacks.onSetPeerConnection({ peerConnection });

    peerConnection.addTransceiver("video", { direction: "recvonly" });
    peerConnection.addTransceiver("audio", { direction: "recvonly" });

    peerConnection.ontrack = (event) => {
      // Same probe wiring as the WebSocket path.
      if (playSettings.latencyProbe && event.track.kind === "video")
        keepUntilStopped(peerConnection, startReceiverProbe(event.receiver));
      if (playSettings.latencyProbe && event.track.kind !== "video")
        keepUntilStopped(peerConnection,
          passThroughEncodedFrames(event.receiver, 'play audio receiver'));
      if (callbacks.onPeerConnectionOnTrack) {
        callbacks.onPeerConnectionOnTrack(event);
      }
    };

    peerConnection.onconnectionstatechange = (event) => {
      reportConnectionState(event.currentTarget.connectionState, callbacks, session);
    };

    // Auto-recovery: when ICE drops, restartIce() flags fresh credentials and fires
    // onnegotiationneeded (handled below). Reuses the same recovery state machine as the
    // WebSocket path so the heuristics stay in one place.
    session.recovery = attachIceRestartRecovery(peerConnection);

    // ICE restart over WHEP (RFC 9725): on onnegotiationneeded we PATCH only the new credentials
    // to the resource URL as an application/trickle-ice-sdpfrag; the engine renegotiates ICE on
    // the existing session and returns its new ICE parameters as an sdpfrag, which we splice into
    // the current answer so playback recovers in place.
    peerConnection.onnegotiationneeded = () => {
      // Initial WHEP offer is sent manually below; otherwise only for a restart we asked for.
      if (!negotiationEstablished || !sessionUrl || !consumeIceRestartOffer(peerConnection)) return;
      restartIceOverWhep(peerConnection, sessionUrl, playSettings, session, callbacks);
    };

    peerConnection.onicecandidate = async (event) => {
      const candidate = event.candidate ? event.candidate.candidate : "";

      if (!sessionUrl) {
        pendingCandidates.push(candidate);
        return;
      }
      if (session.closed || session.failed) return;

      // A trickled candidate that does not arrive is not worth ending anything over.
      await loggedFetch(sessionUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/trickle-ice-sdpfrag", ...getAuthHeaders(playSettings.authToken) },
        body: candidate
      }).catch(() => {});
    };

    // Same as the WebSocket path: listen for the channels before the offer (we never renegotiate).
    const dataChannels = keepUntilStopped(
      peerConnection, attachPlayDataChannels(peerConnection, callbacks, playSettings));

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    // Closed while the offer was being made: the teardown has already run.
    if (session.closed || session.failed) return;

    const whepUrl = `${playSettings.signalingURL}/${playSettings.applicationName}/${playSettings.streamName}/whep`;

    // A POST that gets no answer at all is an Engine that cannot be reached, not a refusal.
    const response = await loggedFetch(whepUrl, {
      method: "POST",
      headers: { "Content-Type": "application/sdp", ...getAuthHeaders(playSettings.authToken) },
      body: peerConnection.localDescription.sdp
    }).catch((error) => {
      error.unreachable = true;
      throw error;
    });

    const locationHeader = response.ok ? response.headers.get("Location") : null;
    if (locationHeader)
      sessionUrl = new URL(locationHeader, new URL(whepUrl)).toString();

    // Closed while the POST was out: the resource it made is nobody's now, so give it back.
    if (session.closed || session.failed) {
      if (sessionUrl)
        loggedFetch(sessionUrl, { method: "DELETE", headers: getAuthHeaders(playSettings.authToken) })
          .catch(() => {});
      return;
    }

    if (!response.ok) {
      let description = '';
      try { description = await response.text(); } catch { /* the status alone, then */ }
      const error = new Error(getWhipWhepFailureMessage("WHEP", response.status, playSettings, description));
      error.status = response.status;
      throw error;
    }

    if (sessionUrl) {
      // From here every exit gives the resource back, the teardown included.
      session.whepSessionUrl = sessionUrl;

      for (const candidate of pendingCandidates) {
        await loggedFetch(sessionUrl, {
          method: "PATCH",
          headers: { "Content-Type": "application/trickle-ice-sdpfrag", ...getAuthHeaders(playSettings.authToken) },
          body: candidate
        }).catch(() => {});
      }
      pendingCandidates.length = 0;
    }

    const answerSdp = ensureApplicationSectionInAnswer(
      peerConnection.localDescription.sdp,
      await response.text()
    );

    if (session.closed || session.failed) return;
    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: answerSdp
    });

    negotiationEstablished = true; // from here, onnegotiationneeded means an ICE restart

    handleRefusedDataChannels(answerSdp, dataChannels, callbacks);

  } catch (error) {
    if (callbacks.onError)
      callbacks.onError(error);
  }
};
export default startPlay;
