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

export const createPlaySupervisor = (overrides = {}) => createSessionSupervisor({
  role: 'play',
  startAttempt: startPlay,
  monitors: [stallMonitor],
  words: { lost: 'reconnecting', attempt: 'reconnect attempt' },
  ...overrides,
});

const playSupervisor = createPlaySupervisor();

export default playSupervisor;
