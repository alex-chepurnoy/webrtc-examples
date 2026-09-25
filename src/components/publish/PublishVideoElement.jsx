import React, { useRef, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

// Manage the HTML <video> element and the MediaStream used for publishing

// Long enough to cover releasing one camera and opening the next.
const PICTURE_LOSS_GRACE_MS = 1500;

const PublishVideoElement = () => {

  const videoElement = useRef();
  const { stream } = useSelector ((state) => state.media);

  // Whether there is a picture to show, which is not the same as whether there is a
  // stream: an audio-only capture, or one whose metadata has not arrived, leaves the
  // element at its default 300x150 and the stage would show a stub box.
  const [size, setSize] = useState({ width: 0, height: 0 });
  const hasPicture = size.width > 0 && size.height > 0;

  // Set srcObject on the videoElement every time the stream changes. We must
  // also clear it when the stream is null — iOS Safari keeps the camera
  // hardware pinned until the <video> element detaches its srcObject.
  useEffect(() => {
    if (videoElement.current == null) return;
    if (stream != null) {
      videoElement.current.srcObject = stream;
    } else {
      videoElement.current.srcObject = null;
    }
  },[stream, videoElement]);

  useEffect(() => {
    const video = videoElement.current;
    if (video == null) return undefined;

    let hadPicture = false;
    let grace = null;

    const apply = () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      hadPicture = width > 0 && height > 0;
      setSize({ width, height });
    };

    /*
     * A camera switch passes through no stream, then an audio-only one, on its way to the
     * next camera (CompositorUserMedia releases the old camera first). Losing the picture is
     * only believed after a moment, so the switch keeps the frame and its aspect ratio
     * instead of flashing "Camera preview" in between. Gaining one is shown at once.
     */
    const update = () => {
      clearTimeout(grace);
      grace = null;
      const picture = video.videoWidth > 0 && video.videoHeight > 0;
      if (picture || !hadPicture) apply();
      else grace = setTimeout(apply, PICTURE_LOSS_GRACE_MS);
    };

    // resize covers a mid-stream change of capture size as well as the first frame.
    video.addEventListener('loadedmetadata', update);
    video.addEventListener('resize', update);
    video.addEventListener('emptied', update);

    return () => {
      clearTimeout(grace);
      video.removeEventListener('loadedmetadata', update);
      video.removeEventListener('resize', update);
      video.removeEventListener('emptied', update);
    };
  }, []);

  // No controls: this is a local self-view of the camera, so a transport bar offering to
  // scrub a live capture is noise, and it covers the bottom of the picture.
  //
  // Never display:none until metadata: WebKit may not paint a video that started playing
  // hidden. It is laid out but invisible instead, with the placeholder over it, as the
  // player does.
  return (
    <>
      {!hasPicture && (
        <div className="wz-video-placeholder wz-video-placeholder--over">Camera preview</div>
      )}
      <video
        ref={videoElement}
        id="publisher-video"
        autoPlay
        playsInline
        muted
        style={hasPicture ? { '--wz-video-ar': size.width / size.height } : { visibility: 'hidden' }}
      ></video>
    </>
  );
}

export default PublishVideoElement;
