import { beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetValue, readRecent, rememberValue } from './RecentValues';

describe('recent values', () => {
  beforeEach(() => window.localStorage.clear());

  it('offers nothing before anything has been used', () => {
    expect(readRecent('streamName')).toEqual([]);
  });

  it('keeps the most recent first', () => {
    rememberValue('streamName', 'one');
    rememberValue('streamName', 'two');
    expect(readRecent('streamName')).toEqual(['two', 'one']);
  });

  it('moves a repeat to the front rather than duplicating it', () => {
    ['a', 'b', 'a'].forEach((v) => rememberValue('streamName', v));
    expect(readRecent('streamName')).toEqual(['a', 'b']);
  });

  it('caps the list so the dropdown stays usable', () => {
    for (let i = 0; i < 20; i += 1) rememberValue('streamName', `s${i}`);
    expect(readRecent('streamName')).toHaveLength(8);
    expect(readRecent('streamName')[0]).toBe('s19');
  });

  it('trims, and ignores a blank', () => {
    rememberValue('streamName', '  spaced  ');
    rememberValue('streamName', '   ');
    expect(readRecent('streamName')).toEqual(['spaced']);
  });

  it('keeps each field separate', () => {
    rememberValue('streamName', 'stream');
    rememberValue('applicationName', 'app');
    expect(readRecent('streamName')).toEqual(['stream']);
    expect(readRecent('applicationName')).toEqual(['app']);
  });

  it('forgets one value without touching the rest', () => {
    ['a', 'b', 'c'].forEach((v) => rememberValue('streamName', v));
    expect(forgetValue('streamName', 'b')).toEqual(['c', 'a']);
    expect(readRecent('streamName')).toEqual(['c', 'a']);
  });

  // A private window throws on every storage call; the page must survive it.
  it('survives storage being unavailable', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readRecent('streamName')).toEqual([]);
    expect(() => rememberValue('streamName', 'x')).not.toThrow();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});

// A wss:// URL and an https:// origin cannot stand in for each other.
describe('signalling URLs per transport', () => {
  beforeEach(() => window.localStorage.clear());

  it('keeps the two transports apart', () => {
    rememberValue('signalingURL', 'wss://engine.example/webrtc-session.json', 'wss');
    rememberValue('signalingURL', 'https://engine.example', 'http');

    expect(readRecent('signalingURL', 'wss')).toEqual(['wss://engine.example/webrtc-session.json']);
    expect(readRecent('signalingURL', 'http')).toEqual(['https://engine.example']);
  });

  it('forgets within one transport only', () => {
    rememberValue('signalingURL', 'wss://a/webrtc-session.json', 'wss');
    rememberValue('signalingURL', 'https://a', 'http');

    forgetValue('signalingURL', 'wss://a/webrtc-session.json', 'wss');
    expect(readRecent('signalingURL', 'wss')).toEqual([]);
    expect(readRecent('signalingURL', 'http')).toEqual(['https://a']);
  });

  it('never files a URL under the transport it was not written for', () => {
    rememberValue('signalingURL', 'wss://engine.example/webrtc-session.json', 'http');
    rememberValue('signalingURL', 'https://engine.example', 'wss');

    expect(readRecent('signalingURL', 'http')).toEqual([]);
    expect(readRecent('signalingURL', 'wss')).toEqual([]);
  });
});
