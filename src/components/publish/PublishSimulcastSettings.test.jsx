import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

import rootReducer from '../../reducers/rootReducer';
import * as PublishSettingsActions from '../../actions/publishSettingsActions';
import * as WebRTCPublishActions from '../../actions/webrtcPublishActions';
import PublishSimulcastSettings from './PublishSimulcastSettings';

afterEach(cleanup);

const makeStore = () => configureStore({
  reducer: rootReducer,
  middleware: (getDefault) => getDefault({ serializableCheck: false, immutableCheck: false }),
});

const renderTable = ({ simulcast = true, connected = false } = {}) => {
  const store = makeStore();
  store.dispatch({ type: PublishSettingsActions.SET_PUBLISH_USE_SIMULCAST, useSimulcast: simulcast });
  store.dispatch({ type: WebRTCPublishActions.SET_WEBRTC_PUBLISH_CONNECTED, connected });
  render(<Provider store={store}><PublishSimulcastSettings /></Provider>);
  return store;
};

const renditions = (store) => store.getState().publishSettings.simulcastRenditions;

describe('the simulcast table', () => {
  it('heads its columns Rendition ID, Scale down and Max (kbps), each with an explainer', () => {
    renderTable();
    const headers = within(document.getElementById('simulcast-renditions'))
      .getAllByRole('columnheader').map((th) => th.querySelector('.wz-th > span')?.textContent);
    expect(headers.slice(0, 3)).toEqual(['Rendition ID', 'Scale down', 'Max (kbps)']);
    for (const topic of ['Rendition ID', 'Scale down', 'Max (kbps)', 'Simulcast']) {
      expect(screen.getByRole('button', { name: `About ${topic}` })).toBeEnabled();
    }
  });

  it('explains scale down as a divisor of width and height', () => {
    renderTable();
    const button = screen.getByRole('button', { name: 'About Scale down' });
    const tip = document.getElementById(button.getAttribute('aria-controls'));
    expect(tip).toHaveTextContent('1280x720 becomes 640x360');
    expect(tip).toHaveTextContent('2 is half the width and half the height');
  });

  it('adds no permanent scale down line under the table', () => {
    renderTable();
    // The explanation lives in the pop-over only; the owner did not want a line of its own.
    const visibleText = document.body.innerText ?? document.body.textContent;
    expect(visibleText).not.toMatch(/Scale down divides/);
  });

  it('shows the stored bps as kbps', () => {
    renderTable();
    expect(screen.getByRole('spinbutton', { name: 'Max kbps, rendition h' })).toHaveValue(2500);
    expect(screen.getByRole('spinbutton', { name: 'Max kbps, rendition l' })).toHaveValue(200);
  });

  it('commits a kbps edit as bps on blur, not per keystroke', () => {
    const store = renderTable();
    const field = screen.getByRole('spinbutton', { name: 'Max kbps, rendition m' });
    fireEvent.change(field, { target: { value: '45' } });
    fireEvent.change(field, { target: { value: '450' } });
    expect(renditions(store).find((r) => r.rid === 'm').maxBitrate).toBe(700000);
    fireEvent.blur(field);
    expect(renditions(store).find((r) => r.rid === 'm').maxBitrate).toBe(450000);
  });

  it('commits a kbps edit on Enter too', () => {
    const store = renderTable();
    const field = screen.getByRole('spinbutton', { name: 'Max kbps, rendition h' });
    fireEvent.change(field, { target: { value: '3000' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(renditions(store).find((r) => r.rid === 'h').maxBitrate).toBe(3000000);
  });

  it('keeps max bitrate and scale down editable while connected, and locks the rest', () => {
    renderTable({ connected: true });
    expect(screen.getByRole('spinbutton', { name: 'Max kbps, rendition h' })).toBeEnabled();
    expect(screen.getByRole('spinbutton', { name: 'Scale down, rendition h' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Rendition ID, row 1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove rendition h' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'About Max (kbps)' })).toBeEnabled();
  });

  it('names each remove button for its rendition', () => {
    const store = renderTable();
    for (const rid of ['h', 'm', 'l']) {
      expect(screen.getByRole('button', { name: `Remove rendition ${rid}` })).toBeEnabled();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Remove rendition m' }));
    expect(renditions(store).map((r) => r.rid)).toEqual(['h', 'l']);
  });

  it('falls back to the row number for a rendition with no Rendition ID yet', () => {
    const store = renderTable();
    fireEvent.click(screen.getByRole('button', { name: 'Remove rendition l' }));
    fireEvent.click(screen.getByRole('button', { name: /Add rendition/ }));
    expect(renditions(store)).toHaveLength(3);
    // The new row has scale 1, so it sorts next to h.
    expect(screen.getByRole('button', { name: /^Remove rendition [0-9]$/ })).toBeInTheDocument();
  });

  it('says why no more renditions can be added at the limit', () => {
    renderTable();
    const add = screen.getByRole('button', { name: /Add rendition/ });
    expect(add).toBeDisabled();
    expect(screen.getByText(/Maximum 3 renditions/)).toBeVisible();
    expect(add).toHaveAccessibleDescription(/Chrome encodes at most 3 simulcast layers/);
  });

  it('drops the limit note below the limit', () => {
    renderTable();
    fireEvent.click(screen.getByRole('button', { name: 'Remove rendition l' }));
    const add = screen.getByRole('button', { name: /Add rendition/ });
    expect(add).toBeEnabled();
    expect(screen.queryByText(/Maximum 3 renditions/)).toBeNull();
    expect(add).not.toHaveAttribute('aria-describedby');
  });

  it('shows a rendition error where the table is, in Rendition ID terms', () => {
    renderTable();
    fireEvent.change(screen.getByRole('textbox', { name: 'Rendition ID, row 2' }), { target: { value: 'h' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Duplicate Rendition ID: h');
  });

  it('keeps the limit explained in the Simulcast explainer as well', () => {
    renderTable();
    const button = screen.getByRole('button', { name: 'About Simulcast' });
    act(() => button.focus());
    expect(document.getElementById(button.getAttribute('aria-controls')))
      .toHaveTextContent('Chrome encodes at most 3 simulcast layers');
  });
});
