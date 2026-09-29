/*
 * The player's session supervisor (sessionSupervisor.js): startPlay, plus the stalled-media
 * watch that is the only way a player learns its application was restarted.
 */

import startPlay from './startPlay';
import { createSessionSupervisor } from './sessionSupervisor';
import { startStallWatch } from './stallWatch';

const stallMonitor = ({ handle, reportLost }) => startStallWatch({
  role: 'play',
  peerConnection: handle ? handle.peerConnection : null,
  isIceRestartInProgress: () => Boolean(handle && handle.isIceRestartInProgress && handle.isIceRestartInProgress()),
  onStall: reportLost,
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
