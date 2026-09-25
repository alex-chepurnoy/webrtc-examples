import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_VIDEO_CODEC,
  VIDEO_CODEC_OPTIONS,
  applyVideoCodecPreference,
  canRestrictVideoCodecOffer,
  filterCodecs,
  isVideoCodecOfferable,
} from './CodecUtils';

// Shaped like RTCRtpSender.getCapabilities('video').codecs, in the order Chrome reports:
// VP8 first, H264 next, H265 last of twelve.
const caps = [
  { mimeType: 'video/VP8' },
  { mimeType: 'video/rtx' },
  { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f' },
  { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=640c1f' },
  { mimeType: 'video/AV1' },
  { mimeType: 'video/VP9' },
  { mimeType: 'video/H265' },
];

const names = (list) => list.map((c) => c.mimeType.replace('video/', ''));

describe('defaults', () => {
  // Auto rather than H.264: an explicit codec filters the offer, and a server that will not
  // accept it rejects the video line outright instead of falling back.
  it('defaults to Auto so the browser offer is never narrowed by default', () => {
    expect(DEFAULT_VIDEO_CODEC).toBe('auto');
  });

  // Grouped the way an operator reads them: the H.26x pair, then the VPx pair, then AV1.
  it('offers auto plus the codecs the examples care about, in family order', () => {
    expect(VIDEO_CODEC_OPTIONS.map((o) => o.value))
      .toEqual(['auto', 'H264', 'H265', 'VP8', 'VP9', 'AV1']);
  });
});
describe('filterCodecs', () => {
  // Reordering is not enough: the Engine picks from the offer rather than honouring its
  // order, so the alternatives have to be removed for the choice to hold.
  it('removes every other video codec', () => {
    expect(names(filterCodecs(caps, 'H264')).filter((n) => /^(VP8|VP9|AV1|H265)$/.test(n))).toEqual([]);
  });

  it('keeps all matching profiles of the wanted codec', () => {
    expect(names(filterCodecs(caps, 'H264')).filter((n) => n === 'H264')).toHaveLength(2);
  });

  it('keeps rtx, because dropping it breaks retransmission', () => {
    expect(names(filterCodecs(caps, 'H264'))).toContain('rtx');
  });

  it('leaves the offer untouched for auto', () => {
    expect(names(filterCodecs(caps, 'auto'))).toEqual(names(caps));
  });

  it('leaves the offer untouched when the codec is unsupported here', () => {
    expect(names(filterCodecs(caps, 'H266'))).toEqual(names(caps));
  });

  it('never returns an empty list', () => {
    expect(filterCodecs(caps, 'VP9').length).toBeGreaterThan(0);
  });

  it('does not mutate the input', () => {
    const before = names(caps);
    filterCodecs(caps, 'H265');
    expect(names(caps)).toEqual(before);
  });
});

/* jsdom has no WebRTC, so each test below installs the pieces it needs as fakes. */

const stubCapabilities = (codecs) =>
  vi.stubGlobal('RTCRtpSender', { getCapabilities: vi.fn(() => ({ codecs })) });

// A peer connection whose one transceiver owns `sender`. setCodecPreferences is whatever
// the test passes: a spy, a thrower, or undefined for a browser that lacks it.
const fakePeerConnection = (sender, setCodecPreferences) => {
  const transceiver = { sender, setCodecPreferences };
  return { transceiver, getTransceivers: () => [transceiver] };
};

describe('applyVideoCodecPreference', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('narrows the transceiver to the codec and reports it', () => {
    stubCapabilities(caps);
    const sender = {};
    const setCodecPreferences = vi.fn();
    const pc = fakePeerConnection(sender, setCodecPreferences);

    expect(applyVideoCodecPreference(pc, sender, 'H264')).toBe('H264');
    expect(setCodecPreferences).toHaveBeenCalledTimes(1);
    expect(names(setCodecPreferences.mock.calls[0][0])).toEqual(['H264', 'H264', 'rtx']);
  });

  it('reports nothing applied when setCodecPreferences is missing', () => {
    stubCapabilities(caps);
    const sender = {};
    expect(applyVideoCodecPreference(fakePeerConnection(sender, undefined), sender, 'H264')).toBeNull();
  });

  // A throw must not stop the publish; the offer falls back to the browser order.
  it('reports nothing applied when setCodecPreferences throws', () => {
    stubCapabilities(caps);
    const sender = {};
    const pc = fakePeerConnection(sender, () => { throw new Error('InvalidModificationError'); });
    expect(() => applyVideoCodecPreference(pc, sender, 'H264')).not.toThrow();
    expect(applyVideoCodecPreference(pc, sender, 'H264')).toBeNull();
  });

  it('leaves the offer alone when the codec is missing from getCapabilities', () => {
    stubCapabilities(caps.filter((c) => c.mimeType !== 'video/H265'));
    const sender = {};
    const setCodecPreferences = vi.fn();
    expect(applyVideoCodecPreference(fakePeerConnection(sender, setCodecPreferences), sender, 'H265'))
      .toBeNull();
    expect(setCodecPreferences).not.toHaveBeenCalled();
  });

  it('does nothing for auto', () => {
    stubCapabilities(caps);
    const sender = {};
    const setCodecPreferences = vi.fn();
    expect(applyVideoCodecPreference(fakePeerConnection(sender, setCodecPreferences), sender, 'auto'))
      .toBeNull();
    expect(setCodecPreferences).not.toHaveBeenCalled();
  });

  it('does nothing when the sender has no transceiver or WebRTC is absent', () => {
    stubCapabilities(caps);
    const setCodecPreferences = vi.fn();
    expect(applyVideoCodecPreference(fakePeerConnection({}, setCodecPreferences), {}, 'H264')).toBeNull();
    expect(setCodecPreferences).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    const sender = {};
    expect(applyVideoCodecPreference(fakePeerConnection(sender, vi.fn()), sender, 'H264')).toBeNull();
  });
});

describe('isVideoCodecOfferable', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is true for a codec in getCapabilities, whatever its case', () => {
    stubCapabilities(caps);
    expect(isVideoCodecOfferable('H265')).toBe(true);
    expect(isVideoCodecOfferable('h264')).toBe(true);
  });

  // Edge: no H.265 over WebRTC, so it is simply absent from the list.
  it('is false for a codec missing from getCapabilities', () => {
    stubCapabilities(caps.filter((c) => c.mimeType !== 'video/H265'));
    expect(isVideoCodecOfferable('H265')).toBe(false);
  });

  it('cannot answer for auto, without WebRTC, or when getCapabilities throws', () => {
    stubCapabilities(caps);
    expect(isVideoCodecOfferable('auto')).toBeNull();

    vi.stubGlobal('RTCRtpSender', { getCapabilities: () => { throw new Error('nope'); } });
    expect(isVideoCodecOfferable('H264')).toBeNull();

    vi.unstubAllGlobals();
    expect(isVideoCodecOfferable('H264')).toBeNull();
  });
});

describe('canRestrictVideoCodecOffer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is true when transceivers have setCodecPreferences', () => {
    const Transceiver = function Transceiver() {};
    Transceiver.prototype.setCodecPreferences = () => {};
    vi.stubGlobal('RTCRtpTransceiver', Transceiver);
    expect(canRestrictVideoCodecOffer()).toBe(true);
  });

  it('is false when they do not, so the form can say the choice is ignored', () => {
    vi.stubGlobal('RTCRtpTransceiver', function Transceiver() {});
    expect(canRestrictVideoCodecOffer()).toBe(false);
  });

  it('cannot answer without WebRTC', () => {
    expect(canRestrictVideoCodecOffer()).toBeNull();
  });
});
