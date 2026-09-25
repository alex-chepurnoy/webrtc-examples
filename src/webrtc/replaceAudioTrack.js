// replaceAudioTrack

import { logEvent } from '../diagnostics/signalLog';
import { watchSentTrack } from './sentTrackWatch';

const replaceAudioTrack = (newAudioTrack, audioSender, peerConnection, callbacks) =>
{
  if (newAudioTrack === undefined) return;
  // Accept null (to remove the current track) or a real MediaStreamTrack.
  if (newAudioTrack !== null && typeof newAudioTrack.kind !== 'string') return;

  if (audioSender == null)
  {
    if (newAudioTrack === null) return;
    let newAudioSender = peerConnection.addTrack(newAudioTrack);
    watchSentTrack(peerConnection, 'audio', newAudioTrack);
    if (callbacks.onSetSenders)
      callbacks.onSetSenders({audioSender:newAudioSender});
  }
  else
  {
    // The listeners follow the track the sender carries, and only once it carries it.
    Promise.resolve(audioSender.replaceTrack(newAudioTrack))
      .then(() => watchSentTrack(peerConnection, 'audio', newAudioTrack))
      .catch((error) => logEvent('error', 'pc', 'publish could not replace the audio track',
        error?.message ?? String(error)));
  }
}
export default replaceAudioTrack;
