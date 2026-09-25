export const videoFrameSizes = [
  { value:"default", name:"Default" },
  { value:"1920x1080", name:"1920x1080" },
  { value:"1280x720", name:"1280x720" },
  { value:"800x600", name:"800x600" },
  { value:"640x360", name:"640x360" }
];

/*
 * Frame size constraints.
 *
 * "default" asks for 1280x720 with `ideal` and nothing else. It previously also carried
 * min 640x360 / max 1920x1080, but `min` is a hard requirement in getUserMedia, not a hint,
 * so any camera that could not reach 640x360 failed with OverconstrainedError the moment the
 * page loaded - under an option labelled "Default". `ideal` can never fail: the browser
 * picks the closest mode the camera has. It cannot be dropped either, because with no size
 * constraint at all Chrome and Firefox capture 640x480, a 4:3 picture nobody asked for.
 *
 * The explicit sizes keep `exact`, because asking for 1280x720 and silently getting something
 * else would make the option meaningless. Those legitimately fail on a camera that cannot do
 * them, and the error message for that case is accurate.
 *
 * Values are numbers: ConstrainULong is numeric, and strings only worked by coercion.
 */
export const videoConstraintsByFrameSize = {
  "default": {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 }
  },
  "1920x1080": {
    width: { exact: 1920 },
    height: { exact: 1080 },
    frameRate: { ideal: 30 }
  },
  "1280x720": {
    width: { exact: 1280 },
    height: { exact: 720 },
    frameRate: { ideal: 30 }
  },
  "800x600": {
    width: { exact: 800 },
    height: { exact: 600 },
    frameRate: { ideal: 30 }
  },
  "640x360": {
    width: { exact: 640 },
    height: { exact: 360 },
    frameRate: { ideal: 30 }
  }
}
export const publishUrlParametersPrefix = "";

export const publishUrlParameters = [
  "signalingURL",
  "applicationName",
  "streamName",
  "videoFrameRate",
  "videoFrameSize"
]