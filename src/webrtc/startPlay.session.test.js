import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import startPlay from './startPlay';
import rootReducer from '../reducers/rootReducer';
import { triggerIceRestart } from '../utils/IceRestartUtils';
import { clearLog, getEntries } from '../diagnostics/signalLog';
import { installFakes, lastPeerConnection, lastSocket, settle } from './fakeSignaling';

/*
 * One play attempt's lifecycle, as startPublish.session.test.js covers the publisher's: the
 * signals that mean the Engine lost the session, and the teardown on every way out.
 */

const settings = (extra = {}) => ({
  ...rootReducer(undefined, { type: '@@init' }).playSettings,
  signalingURL: 'wss://engine.example/webrtc-session.json',
  applicationName: 'live',
  streamName: 'cam',
  ...extra,
});

const labels = () => getEntries().map((e) => `${e.direction} ${e.channel}: ${e.label}`);

const callbacks = () => ({
  onError: vi.fn(),
  onSessionLost: vi.fn(),
  onConnectionStateChange: vi.fn(),
  onSetPeerConnection: vi.fn(),
  onSetWebsocket: vi.fn(),
  onPeerConnectionOnTrack: vi.fn(),
});

const offered = async () => {
  const cb = callbacks();
  const handle = startPlay(settings(), cb);
  const ws = lastSocket();
  ws.open();
  await settle();
  await settle();
  return { cb, handle, ws, pc: lastPeerConnection() };
};

const goLive = async () => {
  const live = await offered();
  live.ws.reply({ statusCode: 200, message: { connectionId: 'v1', sdp: 'v=0\r\n' } });
  await settle();
  live.pc.setConnectionState('connected');
  return live;
};

beforeEach(() => {
  vi.useFakeTimers();
  installFakes({ withSocket: true });
  clearLog();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('startPlay over WebSocket signaling', () => {
  it('reports a socket the server closed as a lost session', async () => {
    const { ws, cb, pc } = await goLive();
    ws.serverClose(1001, 'going away');
    expect(cb.onSessionLost).toHaveBeenCalledWith({ status: null, reason: 'signaling socket closed unexpectedly (code 1001)' });
    expect(pc.closed).toBe(true);
  });

  it('reports "not running" with its status, so a replay can wait for the stream', async () => {
    const { ws, cb, pc } = await offered();
    ws.reply({ statusCode: 502, statusDescription: 'Live stream is not running: cam' });
    expect(cb.onError).toHaveBeenCalledWith({ message: 'Websocket Error: Live stream is not running: cam', status: 502 });
    expect(pc.closed).toBe(true);
  });

  it('cancels the "not ready" retry when the attempt is closed', async () => {
    const { ws, handle } = await offered();
    ws.reply({ statusCode: 514, statusDescription: 'Stream not ready: cam' });
    handle.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ws.sentTypes().filter((t) => t === 'OFFER')).toHaveLength(1);
  });

  it('calls a 410 to ICE_RESTART a lost session', async () => {
    const { ws, cb, pc } = await goLive();
    triggerIceRestart(pc);
    await settle();
    await settle();
    expect(ws.sentTypes()).toContain('ICE_RESTART');
    ws.reply({ statusCode: 410, statusDescription: 'Session is gone' });
    expect(cb.onSessionLost).toHaveBeenCalledWith({ reason: 'ICE_RESTART answered 410', status: 410 });
    expect(labels()).toContain('error ws: play status 410 to ICE_RESTART: Session is gone');
    expect(ws.sentTypes()).toContain('CLOSE');
  });

  it('gives an unanswered ICE restart 8 s', async () => {
    const { cb, pc } = await goLive();
    triggerIceRestart(pc);
    await settle();
    await settle();
    await vi.advanceTimersByTimeAsync(8000);
    expect(cb.onSessionLost).toHaveBeenCalledWith({ reason: 'ICE restart unanswered after 8 s' });
    expect(labels()).toContain('warn pc: play ICE restart unanswered after 8 s');
  });
});

describe('startPlay over WHEP', () => {
  it('calls a refused ICE restart PATCH a lost session', async () => {
    const fetch = vi.fn(async (url, init) => {
      if (init.method === 'POST') return new Response('v=0\r\n', { status: 201, headers: { Location: '/live/cam/whep/r1' } });
      if (init.method === 'PATCH' && /ice-ufrag/.test(init.body)) return new Response('Unknown resource', { status: 404 });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetch);
    const cb = callbacks();
    startPlay(settings({ useWhep: true, signalingURL: 'https://engine.example' }), cb);
    await settle();
    await settle();
    const pc = lastPeerConnection();
    pc.setConnectionState('connected');
    triggerIceRestart(pc);
    await settle();
    await settle();
    expect(cb.onSessionLost).toHaveBeenCalledWith({ reason: 'WHEP ICE restart rejected (404)', status: 404 });
    expect(labels()).toContain('error http: WHEP ICE restart rejected (404): Unknown resource');
    expect(fetch.mock.calls.some(([url, init]) => init.method === 'DELETE' && url.endsWith('/r1'))).toBe(true);
  });
});
