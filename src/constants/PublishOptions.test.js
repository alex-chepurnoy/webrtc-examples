import { describe, expect, it } from 'vitest';

import { frameRateConstraint, videoConstraintsByFrameSize, videoFrameSizes } from './PublishOptions';
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

describe('frame rate', () => {
  it('turns the setting text into a numeric ideal', () => {
    expect(frameRateConstraint('30')).toEqual({ ideal: 30 });
    expect(frameRateConstraint('29.97')).toEqual({ ideal: 29.97 });
    expect(frameRateConstraint(15)).toEqual({ ideal: 15 });
  });

  it('sends nothing, never NaN, for an empty, auto or non-positive value', () => {
    for (const value of ['', '  ', 'auto', 'abc', '0', '-5', null, undefined]) {
      expect(frameRateConstraint(value)).toBeUndefined();
    }
  });

  it('is not carried per explicit size, where the setting always replaced it', () => {
    for (const { value } of videoFrameSizes.filter((s) => s.value !== 'default')) {
      expect(videoConstraintsByFrameSize[value]).not.toHaveProperty('frameRate');
    }
  });

  it('is applied by the camera action as a number, not the setting string', () => {
    const { constraints } = MediaActions.setCameraFrameSizeAndRate({ video: true }, '1280x720', '24');
    expect(constraints.video.frameRate).toEqual({ ideal: 24 });
  });

  it('is cleared by the camera action when the setting is empty', () => {
    const { constraints } = MediaActions.setCameraFrameSizeAndRate(
      { video: { frameRate: { ideal: 30 } } }, 'default', '');
    expect(constraints.video).not.toHaveProperty('frameRate');
    expect(Number.isNaN(constraints.video.frameRate)).toBe(false);
  });
});
