/*
 * The player's session supervisor (sessionSupervisor.js): startPlay, plus the stalled-media
 * watch that is the only way a player learns its application was restarted.
 */

import startPlay from './startPlay';
import { createSessionSupervisor } from './sessionSupervisor';
import { STREAM_LISTED, startStallWatch } from './stallWatch';
import { livenessProbeUrl } from './livenessProbe';
import { LOOKUP_OK, listAvailableStreams } from '../utils/RenditionUtils';

// Whether the Engine still lists the stream, on the liveness check's own kind of socket.
// Anything but a list with the stream in it (missing, refused with 400/403, no answer) is not
// "listed", so the stall is reported and replayed as before.
export const streamListedCheck = (settings, list = listAvailableStreams) => async () => {
  const url = livenessProbeUrl(settings.signalingURL);
  if (!url) return null;
  const result = await list(url, settings.applicationName);
  return result && result.status === LOOKUP_OK && result.streams.includes(settings.streamName)
    ? STREAM_LISTED : null;
};

const stallMonitor = ({ settings, handle, reportLost }) => startStallWatch({
  role: 'play',
  peerConnection: handle ? handle.peerConnection : null,
  isIceRestartInProgress: () => Boolean(handle && handle.isIceRestartInProgress && handle.isIceRestartInProgress()),
  onStall: reportLost,
  checkStream: streamListedCheck(settings),
  streamName: settings.streamName,
});

// The Engine's "Live stream is not running" and "Stream not ready": the publisher is not back
// yet, which a replay waits for rather than counts as a failed attempt.
export const STREAM_NOT_RUNNING_STATUSES = new Set([502, 514]);

export const createPlaySupervisor = (overrides = {}) => createSessionSupervisor({
  role: 'play',
  startAttempt: startPlay,
  monitors: [stallMonitor],
  words: { lost: 'reconnecting', attempt: 'reconnect attempt' },
  isWaitingForStream: (failure) => STREAM_NOT_RUNNING_STATUSES.has(failure && failure.status),
  ...overrides,
});

const playSupervisor = createPlaySupervisor();

export default playSupervisor;
