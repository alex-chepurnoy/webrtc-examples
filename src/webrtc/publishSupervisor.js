/*
 * The publisher's session supervisor (sessionSupervisor.js): startPublish, plus the liveness
 * check that is the only way a publisher learns its application was restarted.
 */

import startPublish from './startPublish';
import { createSessionSupervisor } from './sessionSupervisor';
import { startLivenessProbe } from './livenessProbe';

// Only when the page has both halves of the question to ask: where, and which stream.
const livenessMonitor = ({ settings, handle, reportLost }) => startLivenessProbe({
  role: 'publish',
  signalingURL: settings.signalingURL,
  applicationName: settings.applicationName,
  streamName: settings.streamName,
  isIceRestartInProgress: () => Boolean(handle && handle.isIceRestartInProgress && handle.isIceRestartInProgress()),
  onLost: reportLost,
});

export const createPublishSupervisor = (overrides = {}) => createSessionSupervisor({
  role: 'publish',
  // A fresh socket every time: the supervisor never hands an old one to a new attempt.
  startAttempt: (settings, callbacks) => startPublish(settings, null, callbacks),
  monitors: [livenessMonitor],
  words: { lost: 'republishing', attempt: 'republish attempt' },
  ...overrides,
});

const publishSupervisor = createPublishSupervisor();

export default publishSupervisor;
