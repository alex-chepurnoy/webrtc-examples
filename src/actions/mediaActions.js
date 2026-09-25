import { frameRateConstraint, videoConstraintsByFrameSize } from "../constants/PublishOptions";

export const SET_MEDIA_CANVAS="SET_MEDIA_CANVAS";
export const SET_MEDIA_CONSTRAINTS="SET_MEDIA_CONSTRAINTS";
export const SET_MEDIA_STREAM="SET_MEDIA_STREAM";
export const SET_MEDIA_TRACKS="SET_MEDIA_TRACKS";
export const SET_MEDIA_SCREEN_SHARE_ENDED="SET_MEDIA_SCREEN_SHARE_ENDED";
export const SET_MEDIA_GOT_PERMISSIONS="SET_MEDIA_GOT_PERMISSIONS";
export const SET_MEDIA_CAMERAS="SET_MEDIA_CAMERAS";
export const SET_MEDIA_MICROPHONES="SET_MEDIA_MICROPHONES";
export const SET_MEDIA_DEVICES_STATE="SET_MEDIA_DEVICES_STATE";
export const SET_MEDIA_USERMEDIA_STATE="SET_MEDIA_USERMEDIA_STATE";

export const setCameraFrameSizeAndRate = (constraints, videoFrameSize, videoFrameRate) => {

  let newConstraints = JSON.parse(JSON.stringify(constraints));
  if (typeof newConstraints.video === 'boolean')
  {
    newConstraints.video = {};
  }
  const size = videoConstraintsByFrameSize[videoFrameSize] || videoConstraintsByFrameSize.default;
  // Set or clear each key, so a key the new size does not constrain cannot linger from the last one.
  const next = { width: size.width, height: size.height, frameRate: frameRateConstraint(videoFrameRate) };
  for (const [key, value] of Object.entries(next)) {
    if (value) newConstraints.video[key] = value;
    else delete newConstraints.video[key];
  }

  return {
    type:SET_MEDIA_CONSTRAINTS,
    constraints:newConstraints
  };
}

export const setCamera = (constraints, deviceId) => {

  let newConstraints = JSON.parse(JSON.stringify(constraints));
  if (typeof newConstraints.video === 'boolean')
  {
    newConstraints.video = {};
  }
  newConstraints.video = Object.assign({},newConstraints.video,{deviceId: deviceId});

  return {
    type:SET_MEDIA_CONSTRAINTS,
    constraints: newConstraints
  };
}

export const setMicrophone = (constraints, deviceId) => {

  let newConstraints = JSON.parse(JSON.stringify(constraints));
  if (typeof newConstraints.audio === 'boolean')
  {
    newConstraints.audio = {};
  }
  newConstraints.audio = Object.assign({},newConstraints.audio,{deviceId: deviceId});

  return {
    type:SET_MEDIA_CONSTRAINTS,
    constraints: newConstraints
  };

}