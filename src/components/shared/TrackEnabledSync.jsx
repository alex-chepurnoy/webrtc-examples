import { useEffect } from 'react';
import { useSelector } from 'react-redux';

import { cameraTrackOf } from '../../utils/VideoTrackUtils';

/*
 * Applies the camera and microphone on/off flags to the current tracks. Mounted once at the
 * app root, so it covers every page and any track swap (a new track takes the current flag).
 */
const isTrack = (track) => typeof track?.kind === 'string';

// A MediaStreamTrack is a browser object, not React state; switching it is the point.
const setEnabled = (track, on) => {
  if (isTrack(track)) track.enabled = on;
};

const TrackEnabledSync = () => {
  const { videoTrack, audioTrack, videoEnabled, audioEnabled } = useSelector((state) => state.publishSettings);

  /*
   * With the burned-in clock on, the published track is derived from the camera. Both are
   * switched: the camera so it stops delivering pictures while off, and so it is not left off
   * when the clock is turned off again; the derived track so the viewer gets black, not the
   * last frame. The clock stops drawing while its camera is off (see burnedClock.js).
   */
  useEffect(() => {
    setEnabled(videoTrack, videoEnabled);
    const camera = cameraTrackOf(videoTrack);
    if (camera !== videoTrack) setEnabled(camera, videoEnabled);
  }, [videoTrack, videoEnabled]);

  useEffect(() => {
    setEnabled(audioTrack, audioEnabled);
  }, [audioTrack, audioEnabled]);

  return null;
};

export default TrackEnabledSync;
