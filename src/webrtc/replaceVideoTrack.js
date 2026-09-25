// replaceVideoTrack

import { logEvent } from '../diagnostics/signalLog';
import { watchSentTrack } from './sentTrackWatch';

const replaceVideoTrack = (newVideoTrack, videoSender, peerConnection, callbacks) =>
{
  if (newVideoTrack === undefined) return;
  // Accept null (to remove the current track) or a real MediaStreamTrack.
  // Anything else (e.g. the `{}` initial state) is a no-op, which guards against
  // RTCPeerConnection.addTrack throwing on non-track values.
  if (newVideoTrack !== null && typeof newVideoTrack.kind !== 'string') return;

  if (videoSender == null)
  {
    if (newVideoTrack === null) return;
    let newVideoSender = peerConnection.addTrack(newVideoTrack);
    watchSentTrack(peerConnection, 'video', newVideoTrack);
    if (callbacks.onSetSenders)
      callbacks.onSetSenders({videoSender:newVideoSender});
  }
  else
  {
    // The listeners follow the track the sender carries, and only once it carries it.
    Promise.resolve(videoSender.replaceTrack(newVideoTrack))
      .then(() => watchSentTrack(peerConnection, 'video', newVideoTrack))
      .catch((error) => logEvent('error', 'pc', 'publish could not replace the video track',
        error?.message ?? String(error)));
  }
}
export default replaceVideoTrack;
