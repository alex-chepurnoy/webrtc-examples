import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

import TrackEnabledSync from './TrackEnabledSync';
import { CAMERA_SOURCE_KEY } from '../../utils/VideoTrackUtils';

const storeWith = (publishSettings) => configureStore({
  reducer: { publishSettings: (state = publishSettings) => state },
  middleware: (getDefault) => getDefault({ serializableCheck: false, immutableCheck: false }),
});

const renderWith = (publishSettings) => render(
  <Provider store={storeWith(publishSettings)}>
    <TrackEnabledSync />
  </Provider>,
);

describe('TrackEnabledSync', () => {
  it('switches the camera and the published track together when the clock is on', () => {
    const camera = { kind: 'video', enabled: true };
    const clocked = { kind: 'video', enabled: true, [CAMERA_SOURCE_KEY]: camera };

    renderWith({ videoTrack: clocked, audioTrack: null, videoEnabled: false, audioEnabled: true });

    expect(clocked.enabled).toBe(false);
    expect(camera.enabled).toBe(false);
  });

  // Camera off, clock on, camera on: the picture under the clock must come back.
  it('turns the camera back on, not only the track drawn from it', () => {
    const camera = { kind: 'video', enabled: false };
    const clocked = { kind: 'video', enabled: false, [CAMERA_SOURCE_KEY]: camera };

    renderWith({ videoTrack: clocked, audioTrack: null, videoEnabled: true, audioEnabled: true });

    expect(clocked.enabled).toBe(true);
    expect(camera.enabled).toBe(true);
  });

  it('switches a plain camera track on its own', () => {
    const camera = { kind: 'video', enabled: true };
    const microphone = { kind: 'audio', enabled: true };

    renderWith({
      videoTrack: camera, audioTrack: microphone, videoEnabled: false, audioEnabled: false,
    });

    expect(camera.enabled).toBe(false);
    expect(microphone.enabled).toBe(false);
  });
});
