import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import startPublish from './startPublish';
import rootReducer from '../reducers/rootReducer';
import { triggerIceRestart } from '../utils/IceRestartUtils';
import { clearLog, getEntries, instrumentWebSocket } from '../diagnostics/signalLog';
import { FakeSocket, installFakes, lastPeerConnection, settle } from './fakeSignaling';

/*
 * One publish attempt's lifecycle over WebSocket signaling and WHIP: how it tells a lost
 * session from a blip, and that every way out tears the attempt down. The Engine is a
 * FakeSocket the test answers by hand.
 */

const settings = (extra = {}) => ({
  ...rootReducer(undefined, { type: '@@init' }).publishSettings,
  signalingURL: 'wss://engine.example/webrtc-session.json',
  applicationName: 'live',
  streamName: 'cam',
  audioTrack: null,
  videoTrack: null,
  ...extra,
});

const labels = () => getEntries().map((e) => `${e.direction} ${e.channel}: ${e.label}`);

const callbacks = () => ({
  onError: vi.fn(),
  onSessionLost: vi.fn(),
  onConnectionStateChange: vi.fn(),
  onSetPeerConnection: vi.fn(),
  onSetWebsocket: vi.fn(),
  onSetSenders: vi.fn(),
});

// Open, offer, answer, connect: a publish that is live.
const goLive = async ({ instrument = false } = {}) => {
  const ws = new FakeSocket();
  if (instrument) instrumentWebSocket(ws, 'publish');
  const cb = callbacks();
  const handle = startPublish(settings(), ws, cb);
  ws.open();
  const pc = lastPeerConnection();
  pc.onnegotiationneeded();
  await settle();
  ws.reply({ statusCode: 200, message: { connectionId: 'c1', sdp: 'v=0\r\n' } });
  await settle();
  pc.setConnectionState('connected');
  return { ws, cb, handle, pc };
};

const restartIce = async (pc) => {
  triggerIceRestart(pc);
  await settle();
};

beforeEach(() => {
  vi.useFakeTimers();
  installFakes();
  clearLog();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('startPublish over WebSocket signaling', () => {
  it('reports a socket the server closed as a lost session, and says so as an error', async () => {
    const { ws, cb, pc } = await goLive({ instrument: true });
    ws.serverClose(1006);
    expect(cb.onSessionLost).toHaveBeenCalledWith({ status: null, reason: 'signaling socket closed unexpectedly (code 1006)' });
    expect(cb.onError).not.toHaveBeenCalled();
    expect(labels()).toContain('error ws: publish socket closed unexpectedly (code 1006)');
    expect(pc.closed).toBe(true);
  });

  it('marks a socket that never opened as the Engine being unreachable', () => {
    const ws = new FakeSocket();
    const cb = callbacks();
    startPublish(settings(), ws, cb);
    ws.dispatchEvent(new Event('error'));
    expect(cb.onError).toHaveBeenCalledWith(expect.objectContaining({ unreachable: true }));
  });

  it('reads the Engine status off a 4xxx close code', async () => {
    const { ws, cb } = await goLive({ instrument: true });
    ws.serverClose(4410, 'application shut down');
    expect(cb.onSessionLost).toHaveBeenCalledWith({
      status: 410, reason: 'the Engine ended the session (status 410: application shut down)',
    });
    expect(labels()).toContain('error ws: publish socket closed unexpectedly (code 4410, Engine status 410)');
  });

  it('gives an unanswered ICE restart 8 s, then calls the session lost and clears the restart', async () => {
    const { ws, cb, handle, pc } = await goLive();
    await restartIce(pc);
    expect(ws.sentTypes()).toContain('ICE_RESTART');
    expect(handle.isIceRestartInProgress()).toBe(true);

    // settle() above has already moved the clock 1 ms.
    await vi.advanceTimersByTimeAsync(7990);
    expect(cb.onSessionLost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(cb.onSessionLost).toHaveBeenCalledWith({ reason: 'ICE restart unanswered after 8 s' });
    expect(handle.isIceRestartInProgress()).toBe(false);
    expect(labels()).toContain('warn pc: publish ICE restart unanswered after 8 s');
    // Torn down with CLOSE, so the Engine lets go of the stream name.
    expect(ws.sentTypes()).toContain('CLOSE');
    expect(pc.closed).toBe(true);
  });

  it('calls a 400 to ICE_RESTART a lost session, not an error', async () => {
    const { ws, cb, pc } = await goLive();
    await restartIce(pc);
    ws.reply({ statusCode: 400, statusDescription: 'No session on this signaling channel; only an OFFER may open one.' });
    expect(cb.onSessionLost).toHaveBeenCalledWith({ reason: 'ICE_RESTART answered 400', status: 400 });
    expect(cb.onError).not.toHaveBeenCalled();
    expect(labels()).toContain('error ws: publish status 400 to ICE_RESTART: Engine has no session for this connection');
  });

  it('asks again after a 425, which is the Engine still busy with a restart', async () => {
    const { ws, cb, pc } = await goLive();
    pc.setIceState('disconnected');
    await restartIce(pc);
    ws.reply({ statusCode: 425, statusDescription: 'restart in progress' });
    expect(cb.onSessionLost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(ws.sentTypes().filter((t) => t === 'ICE_RESTART')).toHaveLength(2);
  });

  it('rolls a busy restart back to stable, so the retry can go out at all', async () => {
    const { ws, pc } = await goLive();
    pc.setIceState('disconnected');
    await restartIce(pc);
    expect(pc.signalingState).toBe('have-local-offer');
    ws.reply({ statusCode: 425, statusDescription: 'restart in progress' });
    await settle();
    expect(pc.signalingState).toBe('stable');
    expect(labels()).toContain(
      'warn ws: publish status 425 to ICE_RESTART: the Engine is still restarting ICE, asking again in 2 s (retry 1 of 3)');
  });

  it('can restart ICE again after a busy answer on a healthy connection', async () => {
    const { ws, pc } = await goLive();
    await restartIce(pc);
    ws.reply({ statusCode: 425 });
    await settle();
    await settle();
    // ICE never dropped, so there is no retry of its own; the next Restart ICE must still go out.
    await vi.advanceTimersByTimeAsync(2000);
    expect(ws.sentTypes().filter((t) => t === 'ICE_RESTART')).toHaveLength(1);
    await restartIce(pc);
    await settle();
    expect(ws.sentTypes().filter((t) => t === 'ICE_RESTART')).toHaveLength(2);
  });

  it('gives a retried restart its own 8 s, and calls the session lost when it goes unanswered', async () => {
    const { ws, cb, handle, pc } = await goLive();
    pc.setIceState('disconnected');
    await restartIce(pc);
    ws.reply({ statusCode: 425 });
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(ws.sentTypes().filter((t) => t === 'ICE_RESTART')).toHaveLength(2);
    expect(handle.isIceRestartInProgress()).toBe(true);
    await vi.advanceTimersByTimeAsync(8000);
    expect(cb.onSessionLost).toHaveBeenCalledWith({ reason: 'ICE restart unanswered after 8 s' });
    expect(handle.isIceRestartInProgress()).toBe(false);
  });

  it('stops asking a busy Engine after three retries and calls the session lost', async () => {
    const { ws, cb, pc } = await goLive();
    pc.setIceState('disconnected');
    await restartIce(pc);
    for (let retry = 1; retry <= 3; retry += 1) {
      ws.reply({ statusCode: 425 });
      await vi.advanceTimersByTimeAsync(2000);
      await settle();
      expect(ws.sentTypes().filter((t) => t === 'ICE_RESTART')).toHaveLength(retry + 1);
    }
    ws.reply({ statusCode: 425 });
    await settle();
    expect(cb.onSessionLost).toHaveBeenCalledWith({ reason: 'ICE restart answered 425 4 times in a row', status: 425 });
  });

  it('never hands a frame to a socket that is not open, and says why', async () => {
    const { ws, cb, pc } = await goLive();
    ws.readyState = 3; // gone, with its close event not yet delivered
    await restartIce(pc);
    expect(ws.sentTypes()).not.toContain('ICE_RESTART');
    expect(labels()).toContain('error ws: publish ICE_RESTART not sent: socket is closed');
    expect(cb.onSessionLost).toHaveBeenCalledWith({ reason: 'ICE_RESTART not sent: the signaling socket is not open' });
  });

  it('tears the peer connection down on an error, and reports only the first failure', async () => {
    const { ws, cb, pc } = await goLive();
    ws.reply({ statusCode: 500, statusDescription: 'Internal error' });
    expect(cb.onError).toHaveBeenCalledWith({ message: 'Websocket Error: Internal error', status: 500 });
    expect(pc.closed).toBe(true);
    ws.serverClose(1006);
    expect(cb.onSessionLost).not.toHaveBeenCalled();
  });

  it('says nothing more after a deliberate close, and sends no CLOSE for a Stop', async () => {
    const { ws, cb, handle, pc } = await goLive();
    handle.close();
    expect(pc.closed).toBe(true);
    expect(ws.readyState).toBe(3);
    expect(ws.sentTypes()).not.toContain('CLOSE');
    expect(cb.onSessionLost).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('calls a connection that fails after an answered restart a lost session', async () => {
    const { ws, cb, pc } = await goLive();
    pc.setIceState('failed');
    await settle();
    ws.reply({ statusCode: 200, message: { sdp: 'v=0\r\n' } });
    await settle();
    pc.setConnectionState('failed');
    expect(cb.onSessionLost).toHaveBeenCalledWith({ reason: 'connection failed after an ICE restart' });
  });
});

describe('startPublish over WHIP', () => {
  const answer = () => new Response('v=0\r\n', { status: 201, headers: { Location: '/live/cam/whip/resource1' } });

  it('calls a refused ICE restart a lost session and keeps the Engine\'s reason', async () => {
    const fetch = vi.fn(async (url, init) => {
      if (init.method === 'POST') return answer();
      if (init.method === 'PATCH' && /ice-ufrag/.test(init.body)) return new Response('No such WHIP session', { status: 400 });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetch);
    const cb = callbacks();
    startPublish(settings({ useWhip: true, signalingURL: 'https://engine.example' }), null, cb);
    await settle();
    await settle();
    const pc = lastPeerConnection();
    pc.setConnectionState('connected');

    await restartIce(pc);
    await settle();
    expect(cb.onSessionLost).toHaveBeenCalledWith({ reason: 'WHIP ICE restart rejected (400)', status: 400 });
    expect(labels()).toContain('error http: WHIP ICE restart rejected (400): No such WHIP session');
    // The resource is given back on the way out.
    expect(fetch.mock.calls.some(([url, init]) => init.method === 'DELETE' && url.endsWith('/resource1'))).toBe(true);
  });

  it('rolls back a WHIP restart answered 425 and asks again', async () => {
    let patches = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init.method === 'POST') return answer();
      if (init.method === 'PATCH' && /ice-ufrag/.test(init.body)) {
        patches += 1;
        return patches === 1
          ? new Response('busy', { status: 425 })
          : new Response('a=ice-ufrag:remote\r\na=ice-pwd:remotepwd\r\n', { status: 200 });
      }
      return new Response(null, { status: 204 });
    }));
    const cb = callbacks();
    startPublish(settings({ useWhip: true, signalingURL: 'https://engine.example' }), null, cb);
    await settle();
    await settle();
    const pc = lastPeerConnection();
    pc.setConnectionState('connected');
    pc.setIceState('disconnected');
    await restartIce(pc);
    await settle();
    expect(pc.signalingState).toBe('stable');
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    await settle();
    expect(patches).toBe(2);
    expect(cb.onSessionLost).not.toHaveBeenCalled();
  });

  it('gives back a resource whose POST came back after the attempt was closed', async () => {
    let resolvePost;
    const fetch = vi.fn((url, init) => (init.method === 'POST'
      ? new Promise((resolve) => { resolvePost = resolve; })
      : Promise.resolve(new Response(null, { status: 200 }))));
    vi.stubGlobal('fetch', fetch);
    const cb = callbacks();
    const handle = startPublish(settings({ useWhip: true, signalingURL: 'https://engine.example' }), null, cb);
    await settle();
    handle.close();
    resolvePost(answer());
    await settle();
    expect(fetch.mock.calls.some(([url, init]) => init.method === 'DELETE' && url.endsWith('/resource1'))).toBe(true);
    expect(cb.onSetPeerConnection).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('keeps the Engine\'s body in a refused POST', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Stream name is already in use', { status: 503 })));
    const cb = callbacks();
    startPublish(settings({ useWhip: true, signalingURL: 'https://engine.example' }), null, cb);
    await settle();
    await settle();
    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(cb.onError.mock.calls[0][0].message).toBe('WHIP request failed: 503 (Stream name is already in use).');
    expect(cb.onError.mock.calls[0][0].status).toBe(503);
  });
});
