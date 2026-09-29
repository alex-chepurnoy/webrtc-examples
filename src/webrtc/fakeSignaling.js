/*
 * Stand-ins for a signaling socket and a peer connection, for the unit tests of the attempt
 * lifecycle in startPublish and startPlay. Test code only: nothing in the app imports this.
 *
 * FakeSocket plays both ends: the test opens it, sends it Engine replies and closes it from
 * the server side, and reads back what the page sent. FakePeerConnection does just enough of
 * RTCPeerConnection for negotiation, ICE restart and teardown to run.
 */

import { vi } from 'vitest';

const closeEvent = (code, reason) => Object.assign(new Event('close'), { code, reason });

export class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url = 'wss://engine.example/webrtc-session.json?webrtcImplementation=v2') {
    super();
    FakeSocket.instances.push(this);
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.binaryType = 'blob';
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(closeEvent(1005, ''));
  }

  // Test side.
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  reply(message) {
    this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(message) }));
  }

  serverClose(code, reason = '') {
    this.readyState = 3;
    this.dispatchEvent(closeEvent(code, reason));
  }

  sentTypes() {
    return this.sent.map((frame) => frame.messageType);
  }
}

export class FakePeerConnection extends EventTarget {
  static instances = [];

  constructor(config) {
    super();
    this.config = config;
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.currentRemoteDescription = null;
    this.closed = false;
    FakePeerConnection.instances.push(this);
  }

  addTrack() { return { getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} }; }

  addTransceiver() { return {}; }

  createDataChannel() { return new EventTarget(); }

  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:local\r\na=ice-pwd:localpwd\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' };
  }

  async setLocalDescription(description) { this.localDescription = description; }

  async setRemoteDescription(description) {
    if (this.closed) throw new Error('closed');
    this.remoteDescription = description;
    this.currentRemoteDescription = description;
  }

  async addIceCandidate() {}

  async getStats() { return new Map(); }

  getSenders() { return []; }

  restartIce() {
    queueMicrotask(() => { if (this.onnegotiationneeded) this.onnegotiationneeded(); });
  }

  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }

  // Test side.
  setConnectionState(state) {
    this.connectionState = state;
    if (this.onconnectionstatechange) this.onconnectionstatechange({ currentTarget: this });
    this.dispatchEvent(new Event('connectionstatechange'));
  }

  setIceState(state) {
    this.iceConnectionState = state;
    if (this.oniceconnectionstatechange) this.oniceconnectionstatechange();
  }
}

class FakeDescription {
  constructor(init) { Object.assign(this, init); }
}

// withSocket also replaces WebSocket, for code that opens its own (startPlay does).
export const installFakes = ({ withSocket = false } = {}) => {
  FakePeerConnection.instances = [];
  FakeSocket.instances = [];
  if (withSocket) vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  vi.stubGlobal('RTCSessionDescription', FakeDescription);
  vi.stubGlobal('RTCIceCandidate', FakeDescription);
};

export const lastSocket = () => FakeSocket.instances[FakeSocket.instances.length - 1];

export const lastPeerConnection = () => FakePeerConnection.instances[FakePeerConnection.instances.length - 1];

// Lets the promise chains inside negotiation run, with fake timers installed.
export const settle = async () => { await vi.advanceTimersByTimeAsync(1); };
