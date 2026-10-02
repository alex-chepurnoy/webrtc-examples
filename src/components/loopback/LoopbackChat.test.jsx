import React from 'react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import rootReducer from '../../reducers/rootReducer';
import * as PlaySettingsActions from '../../actions/playSettingsActions';
import * as PublishSettingsActions from '../../actions/publishSettingsActions';
import { addDataChannelMessage } from '../../actions/dataChannelActions';
import LoopbackChat from './LoopbackChat';

const setup = ({ publish = false, play = false } = {}) => {
  const store = configureStore({
    reducer: rootReducer,
    middleware: (getDefault) => getDefault({ serializableCheck: false, immutableCheck: false }),
  });
  store.dispatch({ type: PublishSettingsActions.SET_PUBLISH_CHAT_ENABLED, chatEnabled: publish });
  store.dispatch({ type: PlaySettingsActions.SET_PLAY_CHAT_ENABLED, chatEnabled: play });
  render(<Provider store={store}><LoopbackChat /></Provider>);
  return store;
};

const toggle = () => screen.getByRole('button', { name: /^Chat/ });
const message = (text) => ({ direction: 'received', text, binary: false });

describe('LoopbackChat', () => {
  it('renders nothing while chat is off on both sides', () => {
    setup();
    expect(document.querySelector('#loopback-chat')).toBeNull();
  });

  it('is collapsed by default and names the region it controls', () => {
    setup({ publish: true, play: true });
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(toggle()).toHaveAttribute('aria-controls', 'loopback-chat-region');
    expect(document.getElementById('loopback-chat-region')).toHaveAttribute('hidden');
  });

  it('shows both labeled panels when open and both sides have chat', () => {
    setup({ publish: true, play: true });
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('loopback-chat-region')).not.toHaveAttribute('hidden');
    expect(screen.getByRole('group', { name: 'Publisher chat' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Player chat' })).toBeInTheDocument();
    expect(document.querySelector('#data-channel-panel-publish')).not.toBeNull();
    expect(document.querySelector('#data-channel-panel-play')).not.toBeNull();
  });

  it('shows only the side that has chat enabled', () => {
    setup({ play: true });
    fireEvent.click(toggle());
    expect(screen.queryByRole('group', { name: 'Publisher chat' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Player chat' })).toBeInTheDocument();
  });

  it('counts messages from the enabled sides and keeps them when collapsed', () => {
    const store = setup({ publish: true, play: true });
    expect(toggle()).toHaveTextContent('0 messages');

    act(() => {
      store.dispatch(addDataChannelMessage('publish', message('one')));
      store.dispatch(addDataChannelMessage('play', message('two')));
    });
    expect(toggle()).toHaveTextContent('2 messages');

    fireEvent.click(toggle());
    expect(screen.getByText('one')).toBeInTheDocument();
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(screen.getByText('one')).toBeInTheDocument();
    expect(screen.getByText('two')).toBeInTheDocument();
  });

  it('says "1 message" in the singular', () => {
    const store = setup({ publish: true });
    act(() => { store.dispatch(addDataChannelMessage('publish', message('solo'))); });
    expect(toggle()).toHaveTextContent('1 message');
    expect(toggle()).not.toHaveTextContent('1 messages');
  });

  it('keeps a half-typed message across a collapse', () => {
    setup({ publish: true });
    fireEvent.click(toggle());
    const input = () => document.querySelector('#data-channel-panel-publish input');
    // The channel is closed in a unit test, so the input is disabled: set the draft directly.
    input().disabled = false;
    fireEvent.change(input(), { target: { value: 'draft' } });
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(input().value).toBe('draft');
  });
});
