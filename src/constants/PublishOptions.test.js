import { describe, expect, it } from 'vitest';

import { videoConstraintsByFrameSize, videoFrameSizes } from './PublishOptions';
import * as MediaActions from '../actions/mediaActions';
import mediaReducer from '../reducers/mediaReducer';

describe('default frame size', () => {
  const size = videoConstraintsByFrameSize.default;

  // With no size constraint at all Chrome and Firefox capture 640x480, so Default asks for 720p.
  it('asks for 1280x720 as an ideal', () => {
    expect(size.width).toEqual({ ideal: 1280 });
    expect(size.height).toEqual({ ideal: 720 });
  });

  // min is a hard requirement in getUserMedia; it made Default fail with OverconstrainedError.
  it('carries no hard bound that a camera could fail', () => {
    for (const axis of [size.width, size.height]) {
      expect(axis).not.toHaveProperty('min');
      expect(axis).not.toHaveProperty('max');
      expect(axis).not.toHaveProperty('exact');
    }
  });

  it('keeps exact sizes for every explicit option', () => {
    for (const { value } of videoFrameSizes.filter((s) => s.value !== 'default')) {
      const [w, h] = value.split('x').map(Number);
      expect(videoConstraintsByFrameSize[value].width).toEqual({ exact: w });
      expect(videoConstraintsByFrameSize[value].height).toEqual({ exact: h });
    }
  });

  it('is what a fresh load asks getUserMedia for', () => {
    const { constraints } = mediaReducer(undefined, { type: '@@INIT' });
    expect(constraints.video.width).toEqual({ ideal: 1280 });
    expect(constraints.video.height).toEqual({ ideal: 720 });
  });

  it('is restored on a switch back from an explicit size', () => {
    const explicit = MediaActions.setCameraFrameSizeAndRate(
      { video: { deviceId: 'cam' }, audio: true }, '640x360', '30').constraints;
    const back = MediaActions.setCameraFrameSizeAndRate(explicit, 'default', '30').constraints;
    expect(back.video.width).toEqual({ ideal: 1280 });
    expect(back.video.height).toEqual({ ideal: 720 });
    expect(back.video.deviceId).toBe('cam');
  });
});
