import React, { useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';

import * as PlaySettingsActions from '../../actions/playSettingsActions';
import {
  LOOKUP_ERROR,
  LOOKUP_OK,
  baseStreamName,
  listAvailableStreams,
  renditionsFor,
  signalingLookupUrl,
} from '../../utils/RenditionUtils';

/*
 * Rendition picker. Picking a rendition is picking a stream name (see RenditionUtils). The
 * list is looked up on demand, not polled; under WHEP the socket URL is derived from the origin.
 *
 * A lookup answers for one server, application and stream. It is kept only while all three
 * still match, where picking one of the stream's own renditions counts as the same stream,
 * and the message is worked out from the current name, so it cannot contradict the list.
 */

// Whether a lookup made for `lookup` still answers for the settings on screen now.
const stillApplies = (lookup, lookupUrl, applicationName, streamName, rids) => {
  if (!lookup || lookup.lookupUrl !== lookupUrl || lookup.applicationName !== applicationName) return false;
  if (lookup.streamName === streamName) return true;
  const streams = lookup.result.status === LOOKUP_OK ? lookup.result.streams : [];
  return streams.length > 0
    && baseStreamName(streamName, streams, rids) === baseStreamName(lookup.streamName, streams, rids);
};

const describeLookup = (lookup, streamName, rids) => {
  const { result, lookupUrl, applicationName } = lookup;
  if (result.status === LOOKUP_ERROR) {
    return `The Engine at ${lookupUrl} answered with an error`
      + (result.message ? `: ${result.message}` : '.');
  }
  if (result.status !== LOOKUP_OK) return `Could not reach the Engine at ${lookupUrl}.`;
  if (result.streams.length === 0) return `Nothing is live on the application "${applicationName}".`;

  const found = renditionsFor(streamName, result.streams, rids);
  if (found.length > 0) {
    const count = found.length - 1;
    return `The source and ${count} ${count === 1 ? 'rendition' : 'renditions'} of this stream are live.`;
  }
  return result.streams.includes(streamName)
    ? 'This stream has no simulcast renditions.'
    : 'That stream is not live on this application.';
};

const PlayRenditionSelect = () => {
  const dispatch = useDispatch();
  const playSettings = useSelector((state) => state.playSettings);
  const { connected } = useSelector((state) => state.webrtcPlay);
  // The rids this page's own publisher uses, beyond the default ladder.
  const publishRenditions = useSelector((state) => state.publishSettings?.simulcastRenditions);
  const rids = Array.isArray(publishRenditions) ? publishRenditions.map((r) => r.rid) : [];

  const [lookup, setLookup] = useState(null);
  // What the lookup in flight is asking about, or null.
  const [pending, setPending] = useState(null);
  // Only the newest lookup may land; an older reply is for settings no longer on screen.
  const requestRef = useRef(0);

  const { applicationName, streamName } = playSettings;
  const lookupUrl = signalingLookupUrl(playSettings.signalingURL);

  // A lookup for settings since edited is not this one: Find is offered again, and the
  // newer request makes the older reply stale.
  const looking = pending !== null && pending.lookupUrl === lookupUrl
    && pending.applicationName === applicationName && pending.streamName === streamName;

  // Settings moved on since the lookup: drop it rather than show an answer to another question.
  const applies = stillApplies(lookup, lookupUrl, applicationName, streamName, rids);
  if (lookup && !applies) setLookup(null);

  const streams = applies && lookup.result.status === LOOKUP_OK ? lookup.result.streams : null;
  const options = renditionsFor(streamName, streams, rids);
  const status = applies ? describeLookup(lookup, streamName, rids) : null;

  const look = async () => {
    requestRef.current += 1;
    const request = requestRef.current;
    const asked = { lookupUrl, applicationName, streamName };
    setPending(asked);
    setLookup(null);

    const result = await listAvailableStreams(lookupUrl, applicationName);
    if (request !== requestRef.current) return;
    setPending(null);
    setLookup({ ...asked, result });
  };

  return (
    <div className="mb-3">
      <label htmlFor="playRendition">Rendition</label>
      <div className="wz-inline-row">
        <div className="col">
          <select
            className="form-select"
            id="playRendition"
            name="playRendition"
            aria-describedby="playRendition-hint"
            value={streamName || ''}
            disabled={connected || options.length === 0}
            onChange={(e) =>
              dispatch({
                type: PlaySettingsActions.SET_PLAY_STREAM_NAME,
                streamName: e.target.value,
              })
            }
          >
            {options.length === 0 ? (
              <option value={streamName || ''}>
                {streamName || 'No stream name set'}
              </option>
            ) : (
              options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))
            )}
          </select>
        </div>
        <div className="col-auto">
          <button
            id="play-find-renditions"
            type="button"
            className="btn btn-sm wz-secondary-button"
            disabled={connected || looking || !lookupUrl || !streamName}
            onClick={look}
          >
            {looking ? 'Looking…' : 'Find'}
          </button>
        </div>
      </div>
      {/* Same wording under either transport. Polite, so the result is read once it lands. */}
      <small className="form-text text-muted" id="playRendition-hint" aria-live="polite">
        {!lookupUrl
          ? 'Enter the server URL first; renditions are looked up from that host.'
          : status || 'Ask the Engine which renditions of this stream are live.'}
      </small>
    </div>
  );
};

export default PlayRenditionSelect;
