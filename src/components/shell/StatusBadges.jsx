import React from 'react';
import { useSelector } from 'react-redux';

/*
 * LIVE while publishing, PLAYING while receiving. The live region is always mounted and only
 * its contents come and go: a region inserted together with its first badge is not announced.
 *
 * Both badges show on every page. A session keeps running when its page is left, so a
 * PLAYING badge on Publish is a session still in progress, not a stale flag.
 */
const StatusBadges = () => {
  const publishing = useSelector((state) => state.webrtcPublish.connected);
  const playing = useSelector((state) => state.webrtcPlay.connected);

  const badge = (key, id, label, modifier) => (
    <span
      key={key}
      id={id}
      className={'wz-status__badge wz-status__badge--' + modifier}
    >
      <span className="wz-status__dot" aria-hidden="true" />
      {label}
    </span>
  );

  return (
    <div className="wz-status" role="status" aria-live="polite">
      {publishing ? badge('live', 'video-live-indicator-live', 'LIVE', 'live') : null}
      {playing ? badge('playing', 'video-play-indicator', 'PLAYING', 'playing') : null}
    </div>
  );
};

export default StatusBadges;