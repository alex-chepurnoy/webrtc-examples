/*
 * Chooses which video track a publish carries: the selected camera, or, when that camera has
 * no open track, another open camera, which is what the preview shows.
 */

/*
 * Selections that mean "send no video". '' is the None option; 'none' is what the page sets
 * when a screen share ends mid-publish. Neither names a camera, so neither may fall back to one.
 */
const NO_VIDEO_IDS = new Set(['', 'none']);

/** True when the selection deliberately carries no video. */
export const isNoVideoSelection = (deviceId) => deviceId == null || NO_VIDEO_IDS.has(deviceId);

const isOpen = (track) => Boolean(track) && track.readyState !== 'ended';

/**
 * @param {Object} videoTracksMap  deviceId -> MediaStreamTrack
 * @param {string} deviceId        the selected camera, '' or 'none' for no video, 'screen' for share
 * @param {MediaStreamTrack|null} displayScreenTrack
 * @returns {{ track: MediaStreamTrack|null, usedFallback: boolean }}
 */
export const selectPublishVideoTrack = (videoTracksMap, deviceId, displayScreenTrack) => {
  if (deviceId === 'screen') {
    return { track: displayScreenTrack || null, usedFallback: false };
  }
  if (isNoVideoSelection(deviceId)) {
    return { track: null, usedFallback: false };
  }

  const map = videoTracksMap || {};
  const exact = map[deviceId];
  if (isOpen(exact)) return { track: exact, usedFallback: false };

  // A real camera was chosen and has no open track: send whichever camera is open, which is
  // what the preview shows. An ended track sends nothing, so it is never a candidate.
  const fallbackKey = Object.keys(map).find((key) => key !== deviceId && isOpen(map[key]));
  if (fallbackKey) return { track: map[fallbackKey], usedFallback: true };

  return { track: null, usedFallback: false };
};

/*
 * Where a derived track records the camera it came from. Frame size and rate are camera
 * constraints, and applyConstraints on a derived (drawn-on) track throws.
 */
export const CAMERA_SOURCE_KEY = '__wzClockSource';

/** The camera behind a track, or the track itself when it is already the camera. */
export const cameraTrackOf = (track) => (track && track[CAMERA_SOURCE_KEY]) || track;
