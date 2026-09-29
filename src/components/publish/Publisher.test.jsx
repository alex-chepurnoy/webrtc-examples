import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

import rootReducer from '../../reducers/rootReducer';
import * as PublishSettingsActions from '../../actions/publishSettingsActions';
import * as WebRTCPublishActions from '../../actions/webrtcPublishActions';
import Publisher from './Publisher';

/*
 * The sender limits as the Publisher applies them: one effect per sender, run on connect and
 * on every committed change, with nothing else writing the parameters. The senders are
 * stand-ins that refuse an overlapping setParameters the way Chrome does.
 */

afterEach(cleanup);

const makeStore = () => configureStore({
  reducer: rootReducer,
  middleware: (getDefault) => getDefault({ serializableCheck: false, immutableCheck: false }),
});

const fakeSender = (encodings) => {
  let current = { transactionId: '0', encodings };
  let busy = false;
  const sender = {
    overlaps: 0,
    getParameters: vi.fn(() => JSON.parse(JSON.stringify(current))),
    setParameters: vi.fn((parameters) => {
      if (busy) { sender.overlaps += 1; return Promise.reject(new Error('InvalidModificationError')); }
      busy = true;
      return new Promise((resolve) => setTimeout(() => {
        busy = false;
        current = { ...parameters, transactionId: String(Number(current.transactionId) + 1) };
        resolve();
      }, 2));
    }),
    last: () => current,
  };
  return sender;
};

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

const connect = (store, { video, audio }) => act(() => {
  store.dispatch({ type: WebRTCPublishActions.SET_WEBRTC_PUBLISH_PEERCONNECTION_VIDEO_SENDER, peerConnectionVideoSender: video });
  store.dispatch({ type: WebRTCPublishActions.SET_WEBRTC_PUBLISH_PEERCONNECTION_AUDIO_SENDER, peerConnectionAudioSender: audio });
  store.dispatch({ type: WebRTCPublishActions.SET_WEBRTC_PUBLISH_CONNECTED, connected: true });
});

describe('Publisher sender limits', () => {
  it('starts with no caps and the browser default preference', () => {
    const { publishSettings } = makeStore().getState();
    expect(publishSettings.videoMaxBitrateKbps).toBe('');
    expect(publishSettings.audioMaxBitrateKbps).toBe('');
    expect(publishSettings.degradationPreference).toBe('');
  });

  it('applies the caps on connect and again on each change, without overlapping', async () => {
    const store = makeStore();
    act(() => {
      store.dispatch({ type: PublishSettingsActions.SET_PUBLISH_VIDEO_MAX_BITRATE, videoMaxBitrateKbps: '300' });
      store.dispatch({ type: PublishSettingsActions.SET_PUBLISH_AUDIO_MAX_BITRATE, audioMaxBitrateKbps: '16' });
    });
    render(<Provider store={store}><Publisher /></Provider>);
    const video = fakeSender([{}]);
    const audio = fakeSender([{}]);

    // Nothing is written before the session is up.
    expect(video.setParameters).not.toHaveBeenCalled();
    connect(store, { video, audio });
    await flush();
    expect(video.last().encodings[0].maxBitrate).toBe(300000);
    expect(audio.last().encodings[0].maxBitrate).toBe(16000);

    // Two quick edits in a row: each one is its own write, one after the other.
    act(() => {
      store.dispatch({ type: PublishSettingsActions.SET_PUBLISH_VIDEO_MAX_BITRATE, videoMaxBitrateKbps: '500' });
    });
    act(() => {
      store.dispatch({ type: PublishSettingsActions.SET_PUBLISH_DEGRADATION_PREFERENCE, degradationPreference: 'maintain-framerate' });
    });
    await flush();
    expect(video.overlaps).toBe(0);
    expect(video.last().encodings[0].maxBitrate).toBe(500000);
    expect(video.last().degradationPreference).toBe('maintain-framerate');
    expect(store.getState().errors?.message ?? null).toBeFalsy();
  });

  it('leaves the running cap alone while the field holds an invalid value', async () => {
    const store = makeStore();
    render(<Provider store={store}><Publisher /></Provider>);
    const video = fakeSender([{}]);
    connect(store, { video, audio: null });
    act(() => {
      store.dispatch({ type: PublishSettingsActions.SET_PUBLISH_VIDEO_MAX_BITRATE, videoMaxBitrateKbps: '300' });
    });
    await flush();
    act(() => {
      store.dispatch({ type: PublishSettingsActions.SET_PUBLISH_VIDEO_MAX_BITRATE, videoMaxBitrateKbps: '10' });
    });
    await flush();
    expect(video.last().encodings[0].maxBitrate).toBe(300000);
  });

  it('applies a simulcast bitrate edit to its rung while live', async () => {
    const store = makeStore();
    act(() => {
      store.dispatch({ type: PublishSettingsActions.SET_PUBLISH_USE_SIMULCAST, useSimulcast: true });
    });
    render(<Provider store={store}><Publisher /></Provider>);
    const video = fakeSender([{ rid: 'h' }, { rid: 'm' }, { rid: 'l' }]);
    connect(store, { video, audio: null });
    await flush();
    expect(video.last().encodings.map((e) => e.maxBitrate)).toEqual([2500000, 700000, 200000]);

    const edited = store.getState().publishSettings.simulcastRenditions
      .map((r) => (r.rid === 'm' ? { ...r, maxBitrate: 400000 } : r));
    act(() => {
      store.dispatch({ type: PublishSettingsActions.SET_PUBLISH_SIMULCAST_RENDITIONS, simulcastRenditions: edited });
    });
    await flush();
    expect(video.last().encodings.map((e) => e.maxBitrate)).toEqual([2500000, 400000, 200000]);
    expect(video.overlaps).toBe(0);
  });

  it('never sends a stale single cap under simulcast, even to a sender with no rids', async () => {
    const store = makeStore();
    act(() => {
      store.dispatch({ type: PublishSettingsActions.SET_PUBLISH_VIDEO_MAX_BITRATE, videoMaxBitrateKbps: '100' });
      store.dispatch({ type: PublishSettingsActions.SET_PUBLISH_USE_SIMULCAST, useSimulcast: true });
    });
    render(<Provider store={store}><Publisher /></Provider>);
    // What replaceVideoTrack adds when there was no sender: addTrack, so no rids.
    const video = fakeSender([{}]);
    connect(store, { video, audio: null });
    await flush();
    expect(video.setParameters).toHaveBeenCalled();
    expect(video.last().encodings[0].maxBitrate).toBeUndefined();
  });

  it('reports a failed apply through the error banner', async () => {
    const store = makeStore();
    render(<Provider store={store}><Publisher /></Provider>);
    const video = fakeSender([{}]);
    video.setParameters.mockImplementation(() => Promise.reject(new Error('refused')));
    connect(store, { video, audio: null });
    await flush();
    expect(JSON.stringify(store.getState().errors)).toContain('Could not apply the video limits: refused');
  });
});
