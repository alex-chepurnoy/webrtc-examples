import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

import rootReducer from '../../reducers/rootReducer';
import * as WebRTCPlayActions from '../../actions/webrtcPlayActions';
import Player from './Player';

/*
 * The player's own states, without an Engine: a stand-in stream goes into the store the way
 * the ontrack handler puts a real one there, and the element's events are fired by hand.
 * jsdom has no MediaStream and no media pipeline, so play() is stubbed per test.
 */

const fakeStream = (...kinds) => {
  const tracks = kinds.map((kind) => ({ kind }));
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  };
};

const makeStore = () => configureStore({
  reducer: rootReducer,
  middleware: (getDefault) => getDefault({ serializableCheck: false, immutableCheck: false }),
});

const startSession = (store, stream) => act(() => {
  store.dispatch({ type: WebRTCPlayActions.SET_WEBRTC_PLAY_STREAM, stream });
  store.dispatch({ type: WebRTCPlayActions.SET_WEBRTC_PLAY_CONNECTED, connected: true });
});

const stopSession = (store) => act(() => {
  store.dispatch({ type: WebRTCPlayActions.SET_WEBRTC_PLAY_STREAM, stream: undefined });
  store.dispatch({ type: WebRTCPlayActions.SET_WEBRTC_PLAY_CONNECTED, connected: false });
});

const renderPlayer = (store) => {
  render(<Provider store={store}><Player /></Provider>);
  return document.getElementById('player-video');
};

const refusal = (name) => Object.assign(new Error(name), { name });

// Lets a rejected play() and the retry after it settle.
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe('Player', () => {
  let play;

  beforeEach(() => {
    play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('says it is not playing before a session, and offers no sound control', () => {
    renderPlayer(makeStore());
    expect(screen.getByText('Not playing')).toBeInTheDocument();
    expect(document.getElementById('player-mute-toggle')).toBeNull();
  });

  it('uncovers an audio-only stream once it plays, and lets it be muted', () => {
    const store = makeStore();
    const video = renderPlayer(store);
    const stream = fakeStream('audio');
    startSession(store, stream);

    // Connected, nothing flowing yet: the placeholder still stands in.
    expect(screen.getByText('Waiting for media')).toBeInTheDocument();

    fireEvent.playing(video);

    expect(document.querySelector('.wz-video-placeholder')).toBeNull();
    expect(document.getElementById('rendition-badge')).toHaveTextContent('Audio only');

    const toggle = document.getElementById('player-mute-toggle');
    expect(toggle).toHaveTextContent('Mute');
    // One pattern: the label is the action, so there is no pressed state on top of it.
    expect(toggle).not.toHaveAttribute('aria-pressed');

    fireEvent.click(toggle);
    expect(video.muted).toBe(true);
    expect(toggle).toHaveTextContent('Unmute');
  });

  it('attaches a session that was already running when it mounts', () => {
    const store = makeStore();
    const stream = fakeStream('audio', 'video');
    startSession(store, stream);

    const video = renderPlayer(store);
    expect(video.srcObject).toBe(stream);
  });

  it('offers "Click to unmute" when the browser refuses sound', async () => {
    play.mockRejectedValueOnce(refusal('NotAllowedError'));
    const store = makeStore();
    const video = renderPlayer(store);
    startSession(store, fakeStream('audio', 'video'));

    fireEvent.loadedMetadata(video);
    await settle();

    expect(video.muted).toBe(true);
    expect(play).toHaveBeenCalledTimes(2);
    const unmute = screen.getByRole('button', { name: 'Click to unmute' });

    fireEvent.click(unmute);
    expect(video.muted).toBe(false);
    expect(screen.queryByRole('button', { name: 'Click to unmute' })).toBeNull();
  });

  it('leaves the sound alone when a start is aborted', async () => {
    play.mockRejectedValueOnce(refusal('AbortError'));
    const store = makeStore();
    const video = renderPlayer(store);
    startSession(store, fakeStream('audio', 'video'));

    fireEvent.loadedMetadata(video);
    await settle();

    expect(video.muted).toBe(false);
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Click to unmute' })).toBeNull();
  });

  it('forgets a refusal when the session ends', async () => {
    play.mockRejectedValueOnce(refusal('NotAllowedError'));
    const store = makeStore();
    const video = renderPlayer(store);
    startSession(store, fakeStream('audio'));

    fireEvent.loadedMetadata(video);
    await settle();
    expect(screen.getByRole('button', { name: 'Click to unmute' })).toBeInTheDocument();

    stopSession(store);
    // The next Play click unmutes the element; jsdom does not raise volumechange itself.
    video.muted = false;
    fireEvent(video, new Event('volumechange'));
    startSession(store, fakeStream('audio'));
    fireEvent.playing(video);

    // Muted from the toggle this time, which is a choice, not a refusal to recover from.
    fireEvent.click(document.getElementById('player-mute-toggle'));
    expect(video.muted).toBe(true);
    expect(screen.queryByRole('button', { name: 'Click to unmute' })).toBeNull();
  });
});
