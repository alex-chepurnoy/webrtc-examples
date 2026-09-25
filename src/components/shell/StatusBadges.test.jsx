import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

import rootReducer from '../../reducers/rootReducer';
import * as WebRTCPlayActions from '../../actions/webrtcPlayActions';
import StatusBadges from './StatusBadges';

describe('StatusBadges', () => {
  afterEach(cleanup);

  // A live region only announces changes to itself, so it has to exist before the first badge.
  it('keeps the live region mounted, so the first badge is announced', () => {
    const store = configureStore({
      reducer: rootReducer,
      middleware: (getDefault) => getDefault({ serializableCheck: false, immutableCheck: false }),
    });
    render(<Provider store={store}><StatusBadges /></Provider>);

    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement();

    act(() => store.dispatch({ type: WebRTCPlayActions.SET_WEBRTC_PLAY_CONNECTED, connected: true }));

    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('PLAYING');
  });
});
