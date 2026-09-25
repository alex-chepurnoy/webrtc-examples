import { describe, expect, it } from 'vitest';

import {
  CAMERA_SOURCE_KEY, cameraTrackOf, isNoVideoSelection, selectPublishVideoTrack,
} from './VideoTrackUtils';

const trackA = { id: 'a' };
const trackB = { id: 'b' };
const screen = { id: 'screen' };

describe('selectPublishVideoTrack', () => {
  it('uses the selected camera when its track is open', () => {
    const r = selectPublishVideoTrack({ camA: trackA, camB: trackB }, 'camB', null);
    expect(r.track).toBe(trackB);
    expect(r.usedFallback).toBe(false);
  });

  // The regression this function exists for: preview showed a picture, publish sent none.
  it('falls back to an open track when the selected device has none', () => {
    const r = selectPublishVideoTrack({ camA: trackA }, 'camMissing', null);
    expect(r.track).toBe(trackA);
    expect(r.usedFallback).toBe(true);
  });

  it('returns nothing when no track is open at all', () => {
    const r = selectPublishVideoTrack({}, 'camA', null);
    expect(r.track).toBeNull();
    expect(r.usedFallback).toBe(false);
  });

  it('uses the screen track for a screen share', () => {
    expect(selectPublishVideoTrack({ camA: trackA }, 'screen', screen).track).toBe(screen);
  });

  it('returns nothing for a screen share with no screen track yet', () => {
    expect(selectPublishVideoTrack({ camA: trackA }, 'screen', null).track).toBeNull();
  });

  it('treats an empty selection as deliberately no video', () => {
    expect(selectPublishVideoTrack({ camA: trackA }, '', null).track).toBeNull();
    expect(selectPublishVideoTrack({ camA: trackA }, '', null).usedFallback).toBe(false);
  });

  // A screen share that ends mid-publish sets the selection to 'none'. Falling back from it
  // put the webcam on air without anyone choosing it.
  it("treats 'none' as no video, never as a camera to fall back from", () => {
    const r = selectPublishVideoTrack({ camA: trackA, camB: trackB }, 'none', null);
    expect(r.track).toBeNull();
    expect(r.usedFallback).toBe(false);
  });

  it("treats 'none' as no video even with a screen track still in state", () => {
    expect(selectPublishVideoTrack({ camA: trackA }, 'none', screen).track).toBeNull();
  });

  it('treats a null or undefined selection as no video', () => {
    expect(selectPublishVideoTrack({ camA: trackA }, null, null).track).toBeNull();
    expect(selectPublishVideoTrack({ camA: trackA }, undefined, null).track).toBeNull();
  });

  it('never falls back to an ended track', () => {
    const ended = { id: 'ended', readyState: 'ended' };
    const live = { id: 'live', readyState: 'live' };
    const r = selectPublishVideoTrack({ camA: ended, camB: live }, 'camMissing', null);
    expect(r.track).toBe(live);
    expect(r.usedFallback).toBe(true);
    expect(selectPublishVideoTrack({ camA: ended }, 'camMissing', null).track).toBeNull();
  });

  it('falls back past the selected camera when its own track has ended', () => {
    const ended = { id: 'ended', readyState: 'ended' };
    const r = selectPublishVideoTrack({ camA: ended, camB: trackB }, 'camA', null);
    expect(r.track).toBe(trackB);
    expect(r.usedFallback).toBe(true);
  });

  it('tolerates a missing map', () => {
    expect(selectPublishVideoTrack(undefined, 'camA', null).track).toBeNull();
    expect(selectPublishVideoTrack(null, 'camA', null).track).toBeNull();
  });

  it('never returns a fallback flag when it returns no track', () => {
    const r = selectPublishVideoTrack({}, 'nope', null);
    expect(r.track === null && r.usedFallback === false).toBe(true);
  });
});

describe('isNoVideoSelection', () => {
  it('knows the selections that mean no video', () => {
    ['', 'none', null, undefined].forEach((id) => expect(isNoVideoSelection(id)).toBe(true));
    ['camA', 'screen'].forEach((id) => expect(isNoVideoSelection(id)).toBe(false));
  });
});

describe('cameraTrackOf', () => {
  /*
   * Frame size and frame rate are camera constraints, and a track carrying a drawn clock is no
   * longer the camera. Applying them to the derived track throws, which the publisher reported
   * as "your browser or camera does not support this frame size" before resetting the setting.
   */
  it('gives back a plain track unchanged', () => {
    const track = { kind: 'video' };
    expect(cameraTrackOf(track)).toBe(track);
  });

  // burnedClock.js records the camera on the generator track it hands back to the publisher.
  it('gives back the source camera for a derived track', () => {
    const camera = { kind: 'video', id: 'camera' };
    const derived = { kind: 'video', id: 'derived', [CAMERA_SOURCE_KEY]: camera };
    expect(cameraTrackOf(derived)).toBe(camera);
  });

  it('survives having nothing to look at', () => {
    expect(cameraTrackOf(null)).toBeNull();
    expect(cameraTrackOf(undefined)).toBeUndefined();
  });
});
