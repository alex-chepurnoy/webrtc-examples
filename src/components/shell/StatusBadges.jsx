import React from 'react';
import { useSelector } from 'react-redux';

/*
 * LIVE while publishing, PLAYING while receiving. The live region is always mounted and only
 * its contents come and go: a region inserted together with its first badge is not announced.
 *
 * Both badges show on every page. A session keeps running when its page is left, so a
 * PLAYING badge on Publish is a session still in progress, not a stale flag.
 *
 * While a lost session is being replaced (sessionSupervisor.js) the badge says so, with the
 * attempt, in place of LIVE or PLAYING: the old session is gone and the new one is not up.
 */
const StatusBadges = () => {
  const publishing = useSelector((state) => state.webrtcPublish.connected);
  const playing = useSelector((state) => state.webrtcPlay.connected);
  const publishReconnecting = useSelector((state) => state.webrtcPublish.reconnecting);
  const playReconnecting = useSelector((state) => state.webrtcPlay.reconnecting);

  const badge = (key, id, label, modifier, title) => (
    <span
      key={key}
      id={id}
      className={'wz-status__badge wz-status__badge--' + modifier}
      title={title}
    >
      <span className="wz-status__dot" aria-hidden="true" />
      {label}
    </span>
  );

  // A replay waiting for its stream, or for an Engine that is restarting, is not failing, and
  // the attempt count is not moving; the badge says what it is waiting for instead.
  const WAITING_LABELS = { stream: 'Waiting for stream', engine: 'Waiting for Engine' };
  const reconnectingLabel = (state) => WAITING_LABELS[state.waiting]
    || `Reconnecting ${state.attempt}/${state.max}`;
  const reconnectingTitle = (what, state) =>
    `${what} lost its session with the Engine (${state.reason}) and is starting a new one`;

  return (
    <div className="wz-status" role="status" aria-live="polite">
      {publishReconnecting
        ? badge('publish-reconnecting', 'video-live-indicator-reconnecting',
          reconnectingLabel(publishReconnecting), 'reconnecting',
          reconnectingTitle('Publishing', publishReconnecting))
        : (publishing ? badge('live', 'video-live-indicator-live', 'LIVE', 'live') : null)}
      {playReconnecting
        ? badge('play-reconnecting', 'video-play-indicator-reconnecting',
          reconnectingLabel(playReconnecting), 'reconnecting',
          reconnectingTitle('Playback', playReconnecting))
        : (playing ? badge('playing', 'video-play-indicator', 'PLAYING', 'playing') : null)}
    </div>
  );
};

export default StatusBadges;
