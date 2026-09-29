import React, { useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import * as PublishSettingsActions from '../../actions/publishSettingsActions';
import {
  MAX_SIMULCAST_RENDITIONS,
  MAX_RID_LENGTH,
  SIMULCAST_LIMIT_REASON,
  createSimulcastRendition,
  getSimulcastRenditionsError,
  sortSimulcastRenditions,
} from '../../utils/SimulcastUtils';
import { bpsToKbps, kbpsToBps } from '../../utils/SenderParameters';
import Icon from '../shared/Icon';
import InfoTip from '../shared/InfoTip';

// Simulcast: the on/off toggle plus a table to configure
// each rendition. Rows are kept in SDP preference order, derived from scale
// down (highest last); they re-sort when a scale down edit is finished.
// Rendition ID and the number of renditions are negotiated in the offer,
// so they lock while connected; scale down and max bitrate can change mid-stream.
//
// Max bitrate is stored in bps, which is what the cookie and share link have always held,
// and shown in kbps, which is the scale people think in.

// Scale down and max bitrate edits are kept in a local draft and only dispatched on blur or
// Enter, so a row doesn't jump away while typing and mid-stream setParameters runs once per
// finished edit instead of on every keystroke.
const useDraft = (onCommit) => {
  const [draft, setDraft] = useState(null);
  const commit = () => {
    if (draft == null) return;
    setDraft(null);
    onCommit(draft);
  };
  const inputProps = {
    onChange: (e) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e) => {
      if (e.key !== 'Enter') return;
      // Enter would otherwise submit the form, which has no submit handler of its own.
      e.preventDefault();
      commit();
    },
  };
  return [draft, inputProps];
};

const SimulcastRenditionRow = ({ rendition, index, setupLocked, simulcastDisabled, removable, onFieldChange, onScaleEdited, onBitrateEdited, onRemove }) => {

  const [scaleDraft, scaleProps] = useDraft(onScaleEdited);
  const [bitrateDraft, bitrateProps] = useDraft(onBitrateEdited);

  // Named for the rendition, so a screen reader hears which row the control belongs to.
  // A new row has no Rendition ID yet, so it falls back to its position.
  const name = rendition.rid || `${index + 1}`;
  const removeLabel = `Remove rendition ${name}`;

  return (
    <tr>
      <td>
        <input
          type="text"
          className="form-control form-control-sm"
          maxLength={MAX_RID_LENGTH}
          aria-label={`Rendition ID, row ${index + 1}`}
          value={rendition.rid}
          disabled={setupLocked}
          onChange={(e) => onFieldChange('rid', e.target.value)}
        />
      </td>
      <td>
        <input
          type="number"
          className="form-control form-control-sm"
          min="1"
          step="any"
          aria-label={`Scale down, rendition ${name}`}
          value={scaleDraft ?? rendition.scaleResolutionDownBy}
          disabled={simulcastDisabled}
          {...scaleProps}
        />
      </td>
      <td>
        <input
          type="number"
          className="form-control form-control-sm"
          min="1"
          step="any"
          aria-label={`Max kbps, rendition ${name}`}
          value={bitrateDraft ?? bpsToKbps(rendition.maxBitrate)}
          disabled={simulcastDisabled}
          {...bitrateProps}
        />
      </td>
      <td className="wz-rendition-remove-cell">
        <button
          type="button"
          className="control-button wz-rendition-remove"
          aria-label={removeLabel}
          disabled={setupLocked || !removable}
          onClick={onRemove}
        >
          <Icon name="close" size={12} />
        </button>
      </td>
    </tr>
  );
}

const PublishSimulcastSettings = () => {

  const dispatch = useDispatch();
  const publishSettings = useSelector((state) => state.publishSettings);
  const webrtcPublish = useSelector((state) => state.webrtcPublish);

  const renditions = publishSettings.simulcastRenditions;
  const simulcastDisabled = !publishSettings.useSimulcast;
  const setupLocked = simulcastDisabled || webrtcPublish.connected;
  const atLimit = renditions.length >= MAX_SIMULCAST_RENDITIONS;

  // Said where the table is, not only when Publish is pressed; a live bitrate edit has no
  // Publish press to wait for.
  const renditionsError = simulcastDisabled ? null : getSimulcastRenditionsError(renditions);

  const setRenditions = (simulcastRenditions) => {
    dispatch({
      type: PublishSettingsActions.SET_PUBLISH_SIMULCAST_RENDITIONS,
      simulcastRenditions
    });
  };

  const updateRendition = (index, field, value) => {
    setRenditions(renditions.map((rendition, i) =>
      i === index ? { ...rendition, [field]: value } : rendition
    ));
  };

  const finishScaleEdit = (index, value) => {
    if (Number(value) === Number(renditions[index].scaleResolutionDownBy)) return;
    const updated = renditions.map((rendition, i) =>
      i === index ? { ...rendition, scaleResolutionDownBy: value } : rendition
    );
    setRenditions(sortSimulcastRenditions(updated));
  };

  const finishBitrateEdit = (index, kbps) => {
    const bps = kbpsToBps(kbps);
    if (bps === Number(renditions[index].maxBitrate)) return;
    updateRendition(index, 'maxBitrate', bps);
  };

  const addRendition = () => {
    setRenditions(sortSimulcastRenditions([...renditions, createSimulcastRendition()]));
  };

  const removeRendition = (index) => {
    setRenditions(renditions.filter((_, i) => i !== index));
  };

  return (
    <>
      {/* Laid out rather than hidden in a drawer: a toggle and a table behind a click, in
          a panel that already scrolls, cost a click and bought nothing. No heading of its
          own: it is part of the Video section, and its switch already names it. */}
      <div className="form-check form-switch form-check-inline mb-3">
        <span className="wz-label-row wz-label-row--switch">
          <label className='form-check-label' htmlFor="publishUseSimulcast">
            Enable Simulcast
          </label>
          <InfoTip topic="Simulcast">
            Sends several copies of the video at once, each a rendition with its own size and
            bitrate, so a viewer can take the one their connection carries. The Engine
            republishes each rendition as its own stream: the first keeps the stream name,
            the others get _ and their Rendition ID appended. {SIMULCAST_LIMIT_REASON} The
            Rendition IDs and how many renditions there are are fixed once publishing starts;
            scale down and max bitrate can change while live.
          </InfoTip>
        </span>
        <input
          className='form-check-input form-switch orange-checkbox'
          type="checkbox"
          id="publishUseSimulcast"
          name="publishUseSimulcast"
          checked={publishSettings.useSimulcast || false}
          disabled={webrtcPublish.connected}
          onChange={(e) => dispatch({
            type: PublishSettingsActions.SET_PUBLISH_USE_SIMULCAST,
            useSimulcast: e.target.checked
          })}
        />
      </div>

      <table className="table table-sm align-middle mb-2 wz-renditions" id="simulcast-renditions">
        <thead>
          <tr>
            <th scope="col">
              <span className="wz-th">
                <span>Rendition ID</span>
                <InfoTip topic="Rendition ID">
                  The name of this rendition on the wire (the RTP rid): letters, numbers, - and
                  _, up to {MAX_RID_LENGTH} characters, different on each row. The Engine names
                  the rendition's stream after it, so m becomes streamname_m. Fixed while
                  publishing.
                </InfoTip>
              </span>
            </th>
            <th scope="col">
              <span className="wz-th">
                <span>Scale down</span>
                <InfoTip topic="Scale down">
                  Divides the width and the height by this number. 1 is full size. 2 is half
                  the width and half the height, which is a quarter of the pixels: 1280x720
                  becomes 640x360. 4 is a quarter of each. Can change while live.
                </InfoTip>
              </span>
            </th>
            <th scope="col">
              <span className="wz-th">
                <span>Max (kbps)</span>
                <InfoTip topic="Max (kbps)">
                  The most this rendition may send, in kilobits per second (1000 kbps is 1
                  Mbps). The encoder stays under it and often needs less. Can change while
                  live; the figure announced to the Engine when publishing started stays as it
                  was.
                </InfoTip>
              </span>
            </th>
            <th scope="col"><span className="wz-sr-only">Remove</span></th>
          </tr>
        </thead>
        <tbody>
          {renditions.map((rendition, index) => (
            <SimulcastRenditionRow
              key={rendition.id}
              rendition={rendition}
              index={index}
              setupLocked={setupLocked}
              simulcastDisabled={simulcastDisabled}
              removable={renditions.length > 1}
              onFieldChange={(field, value) => updateRendition(index, field, value)}
              onScaleEdited={(value) => finishScaleEdit(index, value)}
              onBitrateEdited={(value) => finishBitrateEdit(index, value)}
              onRemove={() => removeRendition(index)}
            />
          ))}
        </tbody>
      </table>

      {renditionsError && (
        <small className="wz-field-error mb-2" id="simulcast-renditions-error" role="alert">
          {renditionsError}
        </small>
      )}

      <div className="wz-renditions-actions">
        <button
          type="button"
          className="btn btn-sm btn-drawer-toggle"
          disabled={setupLocked || atLimit}
          aria-describedby={atLimit ? 'simulcast-limit-reason' : undefined}
          onClick={addRendition}
        >
          <Icon name="plus" className="me-1" />Add rendition
        </button>
        {/* A disabled button says nothing about why. The short form is on screen beside it;
            the whole reason is its accessible description, and in the Simulcast explainer. */}
        {atLimit && (
          <small className="wz-renditions-limit" id="simulcast-limit-note">
            Maximum {MAX_SIMULCAST_RENDITIONS} renditions
            <span className="wz-sr-only" id="simulcast-limit-reason">{SIMULCAST_LIMIT_REASON}</span>
          </small>
        )}
      </div>
    </>
  );
}

export default PublishSimulcastSettings;
