import React from 'react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import rootReducer from '../../reducers/rootReducer';
import * as PlaySettingsActions from '../../actions/playSettingsActions';
import { LOOKUP_ERROR, LOOKUP_OK, LOOKUP_UNREACHABLE } from '../../utils/RenditionUtils';
import PlayRenditionSelect from './PlayRenditionSelect';

// The lookup is the socket round trip; everything else in RenditionUtils is the real code.
const lookups = [];
vi.mock('../../utils/RenditionUtils', async (importOriginal) => ({
  ...(await importOriginal()),
  listAvailableStreams: () => new Promise((resolve) => { lookups.push(resolve); }),
}));

const URL_A = 'wss://engine-a.example/webrtc-session.json';
const LIVE = ['diag', 'diag_m', 'diag_l', 'other'];

const setup = () => {
  const store = configureStore({
    reducer: rootReducer,
    middleware: (getDefault) => getDefault({ serializableCheck: false, immutableCheck: false }),
  });
  store.dispatch({ type: PlaySettingsActions.SET_PLAY_SIGNALING_URL, signalingURL: URL_A });
  store.dispatch({ type: PlaySettingsActions.SET_PLAY_APPLICATION_NAME, applicationName: 'webrtc' });
  store.dispatch({ type: PlaySettingsActions.SET_PLAY_STREAM_NAME, streamName: 'diag' });
  render(<Provider store={store}><PlayRenditionSelect /></Provider>);
  return store;
};

const hint = () => screen.getByText((_, el) => el?.id === 'playRendition-hint');
const optionValues = () => [...document.querySelectorAll('#playRendition option')].map((o) => o.value);
const find = () => fireEvent.click(screen.getByRole('button', { name: 'Find' }));
const answer = async (index, result) => {
  await act(async () => { lookups[index](result); });
};

beforeEach(() => { lookups.length = 0; });

describe('PlayRenditionSelect', () => {
  it('lists the renditions a lookup found', async () => {
    setup();
    find();
    await answer(0, { status: LOOKUP_OK, streams: LIVE });
    expect(optionValues()).toEqual(['diag', 'diag_m', 'diag_l']);
    expect(hint()).toHaveTextContent('The source and 2 renditions of this stream are live.');
  });

  it('drops the list when the server, application or stream changes', async () => {
    const changes = [
      { type: PlaySettingsActions.SET_PLAY_SIGNALING_URL, signalingURL: 'wss://engine-b.example/webrtc-session.json' },
      { type: PlaySettingsActions.SET_PLAY_APPLICATION_NAME, applicationName: 'live' },
      { type: PlaySettingsActions.SET_PLAY_STREAM_NAME, streamName: 'other' },
    ];
    for (const change of changes) {
      lookups.length = 0;
      document.body.innerHTML = '';
      const store = setup();
      find();
      await answer(0, { status: LOOKUP_OK, streams: LIVE });
      expect(optionValues()).toHaveLength(3);

      act(() => store.dispatch(change));
      expect(optionValues()).toHaveLength(1);
      expect(hint()).toHaveTextContent('Ask the Engine which renditions of this stream are live.');
    }
  });

  it('keeps the list when one of the stream’s own renditions is picked', async () => {
    setup();
    find();
    await answer(0, { status: LOOKUP_OK, streams: LIVE });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'diag_m' } });
    expect(optionValues()).toEqual(['diag', 'diag_m', 'diag_l']);
  });

  // The name was edited while the Engine was being asked about the old one.
  it('ignores a reply to a stream name that has since changed', async () => {
    const store = setup();
    find();
    act(() => store.dispatch({ type: PlaySettingsActions.SET_PLAY_STREAM_NAME, streamName: 'other' }));
    await answer(0, { status: LOOKUP_OK, streams: LIVE });
    expect(optionValues()).toEqual(['other']);
    expect(hint()).toHaveTextContent(/^Ask the Engine which renditions of this stream are live\.$/);
  });

  it('ignores an older lookup that answers after a newer one', async () => {
    const store = setup();
    find();
    // Edited mid-lookup: Find is offered again for the new name.
    act(() => store.dispatch({ type: PlaySettingsActions.SET_PLAY_STREAM_NAME, streamName: 'other' }));
    expect(screen.getByRole('button', { name: 'Find' })).toBeEnabled();
    find();
    await answer(1, { status: LOOKUP_OK, streams: LIVE });
    expect(hint()).toHaveTextContent('This stream has no simulcast renditions.');

    // Back to the first name, then the first lookup finally answers: it is stale.
    act(() => store.dispatch({ type: PlaySettingsActions.SET_PLAY_STREAM_NAME, streamName: 'diag' }));
    await answer(0, { status: LOOKUP_OK, streams: LIVE });
    expect(optionValues()).toEqual(['diag']);
    expect(hint()).toHaveTextContent(/^Ask the Engine which renditions of this stream are live\.$/);
  });

  it('tells an unreachable Engine from one that answered with an error', async () => {
    setup();
    find();
    await answer(0, { status: LOOKUP_UNREACHABLE });
    expect(hint()).toHaveTextContent(`Could not reach the Engine at ${URL_A}.`);

    find();
    await answer(1, { status: LOOKUP_ERROR, code: 404, message: 'Application not found' });
    expect(hint()).toHaveTextContent(`The Engine at ${URL_A} answered with an error: Application not found`);
  });

  it('says an application with nothing live is empty, not unreachable', async () => {
    setup();
    find();
    await answer(0, { status: LOOKUP_OK, streams: [] });
    expect(hint()).toHaveTextContent('Nothing is live on the application "webrtc".');
  });

  it('announces the result', () => {
    setup();
    expect(hint()).toHaveAttribute('aria-live', 'polite');
  });
});
