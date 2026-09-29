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

/*
 * Leaving the Publish page releases the camera and microphone (CompositorUserMedia), and the
 * publish goes on as it always has, sending tracks that have ended. A republish from there
 * would come up LIVE with no media, so it is not made: the publish stops and says why.
 * Coming back to the page opens the devices again, and a republish then uses the new tracks.
 */
export const RELEASED_TRACKS_MESSAGE =
  'Camera released when the Publish page closed; publish stopped. Open the Publish page and publish again.';

export const endedTracksProblem = (settings) => {
  const tracks = [settings.audioTrack, settings.videoTrack].filter(Boolean);
  if (!tracks.some((track) => track.readyState === 'ended')) return null;
  return {
    reason: 'camera released when the Publish page closed',
    message: RELEASED_TRACKS_MESSAGE,
  };
};

export const createPublishSupervisor = (overrides = {}) => createSessionSupervisor({
  role: 'publish',
  // A fresh socket every time: the supervisor never hands an old one to a new attempt.
  startAttempt: (settings, callbacks) => startPublish(settings, null, callbacks),
  monitors: [livenessMonitor],
  words: { lost: 'republishing', attempt: 'republish attempt' },
  checkAttempt: endedTracksProblem,
  ...overrides,
});

const publishSupervisor = createPublishSupervisor();

export default publishSupervisor;
