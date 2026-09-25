/*
 * Keeps the mute/ended listeners on whichever track a sender is carrying right now. The
 * track changes mid-session (camera switch, screen share, microphone change), so attaching
 * once at publish start watched a track that was no longer being sent and left the new one
 * unwatched.
 *
 * One watch per media kind per peer connection. The session's stop releases whatever is
 * still watched, through the same handles as everything else the session opened.
 */

import { instrumentTrack } from '../diagnostics/signalLog';
import { keepUntilStopped } from './sessionHandles';

const WATCHES = '__wzSentTrackWatches';

const release = (entry) => {
  if (entry && entry.handle) entry.handle.stop();
};

/**
 * Watch `track` as the one the sender of `kind` carries, releasing the previous one.
 * A null track releases the watch and watches nothing.
 */
export const watchSentTrack = (peerConnection, kind, track, role = 'publish') => {
  if (!peerConnection || !kind) return;
  // A replaceTrack that settles after the session stopped must not start a new watch.
  if (peerConnection.signalingState === 'closed') return;

  let watches = peerConnection[WATCHES];
  if (!watches) {
    watches = {};
    peerConnection[WATCHES] = watches;
    keepUntilStopped(peerConnection, () => {
      Object.values(watches).forEach(release);
      delete peerConnection[WATCHES];
    });
  }

  const current = watches[kind];
  if (current && current.track === track) return;

  release(current);
  delete watches[kind];
  if (track) watches[kind] = { track, handle: instrumentTrack(track, role, 'outbound') };
};

/** For tests: the track currently watched for a kind, or null. */
export const watchedTrack = (peerConnection, kind) =>
  (peerConnection && peerConnection[WATCHES] && peerConnection[WATCHES][kind]
    ? peerConnection[WATCHES][kind].track
    : null);
