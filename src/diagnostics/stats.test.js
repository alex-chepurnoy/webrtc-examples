import { afterEach, describe, expect, it, vi } from 'vitest';

import { startStatsPolling, summarizeStats } from './stats';

// getStats() resolves to an RTCStatsReport, which is Map-like. A Map is a faithful stand-in.
const report = (...stats) => new Map(stats.map((s, i) => [s.id || `s${i}`, s]));

const pair = (over = {}) => ({
  type: 'candidate-pair', state: 'succeeded', nominated: true,
  currentRoundTripTime: 0.040, availableOutgoingBitrate: 2_500_000, ...over,
});

const inbound = (over = {}) => ({
  type: 'inbound-rtp', kind: 'video',
  jitterBufferDelay: 12, jitterBufferEmittedCount: 300,   // => 40ms average
  jitter: 0.004, packetsReceived: 9900, packetsLost: 100,
  bytesReceived: 1_000_000, framesPerSecond: 30, frameWidth: 1280, frameHeight: 720, ...over,
});

describe('RTT', () => {
  it('reads currentRoundTripTime from the nominated candidate pair, in ms', () => {
    const s = summarizeStats(report(pair(), inbound()), null, 1000, 0);
    expect(s.rttMs).toBeCloseTo(40);
  });

  it('falls back to the RTCP-reported RTT when no pair RTT is available', () => {
    const s = summarizeStats(
      report(
        pair({ currentRoundTripTime: undefined }),
        { type: 'remote-inbound-rtp', kind: 'video', roundTripTime: 0.085 }
      ), null, 1000, 0);
    expect(s.rttMs).toBeCloseTo(85);
  });

  it('reports null rather than zero when RTT is genuinely unknown', () => {
    const s = summarizeStats(report(inbound()), null, 1000, 0);
    expect(s.rttMs).toBeNull();
  });
});

describe('latency estimate', () => {
  it('is half the RTT plus the average jitter buffer delay', () => {
    // 40ms RTT -> 20ms one way, plus 12/300 = 40ms buffered.
    const s = summarizeStats(report(pair(), inbound()), null, 1000, 0);
    expect(s.jitterBufferMs).toBeCloseTo(40);
    expect(s.estimatedLatencyMs).toBeCloseTo(60);
    expect(s.latencyIsPartial).toBe(false);
  });

  it('flags the estimate as partial when only one half is known', () => {
    const s = summarizeStats(report(pair()), null, 1000, 0);
    expect(s.estimatedLatencyMs).toBeCloseTo(20);
    expect(s.latencyIsPartial).toBe(true);
  });

  it('is null when neither half is known', () => {
    const s = summarizeStats(report({ type: 'outbound-rtp', kind: 'video' }), null, 1000, 0);
    expect(s.estimatedLatencyMs).toBeNull();
  });

  it('does not divide by zero before any frame has been emitted', () => {
    const s = summarizeStats(
      report(pair(), inbound({ jitterBufferEmittedCount: 0, jitterBufferDelay: 0 })), null, 1000, 0);
    expect(s.jitterBufferMs).toBeNull();
    expect(Number.isFinite(s.estimatedLatencyMs)).toBe(true);
  });
});

describe('rates', () => {
  it('derives inbound kbps from the byte delta between two samples', () => {
    const first = report(pair(), inbound({ bytesReceived: 1_000_000 }));
    const second = report(pair(), inbound({ bytesReceived: 1_250_000 }));
    // 250,000 bytes over 2s = 125,000 B/s = 1000 kbps
    const s = summarizeStats(second, first, 3000, 1000);
    expect(s.inboundKbps).toBeCloseTo(1000);
  });

  it('returns null rather than a negative rate when counters reset', () => {
    const first = report(pair(), inbound({ bytesReceived: 5_000_000 }));
    const second = report(pair(), inbound({ bytesReceived: 1000 }));
    expect(summarizeStats(second, first, 3000, 1000).inboundKbps).toBeNull();
  });

  it('has no rate on the very first sample', () => {
    expect(summarizeStats(report(pair(), inbound()), null, 1000, 0).inboundKbps).toBeNull();
  });
});

describe('packet loss', () => {
  it('is a percentage of received plus lost', () => {
    const s = summarizeStats(report(pair(), inbound()), null, 1000, 0);
    expect(s.packetLossPct).toBeCloseTo(1.0); // 100 lost of 10,000
  });

  it('is null when nothing has been received yet', () => {
    const s = summarizeStats(
      report(pair(), inbound({ packetsReceived: 0, packetsLost: 0 })), null, 1000, 0);
    expect(s.packetLossPct).toBeNull();
  });
});

/*
 * Shape reported by Chromium for a three-rung publish: one encoding sending, two active at
 * zero bytes with qualityLimitationReason "bandwidth".
 */
const layer = (rid, over = {}) => ({
  type: 'outbound-rtp', kind: 'video', id: `out-${rid}`, rid,
  bytesSent: 0, framesEncoded: 0, active: true,
  qualityLimitationReason: 'bandwidth', ...over,
});

const SENDING = layer('m', {
  bytesSent: 138_500, framesEncoded: 122, framesPerSecond: 20,
  frameWidth: 320, frameHeight: 240,
});

describe('simulcast layers', () => {
  it('reports every encoding, not just the first one found', () => {
    const s = summarizeStats(report(pair(), layer('h'), SENDING, layer('l')), null, 1000, 0);
    expect(s.outboundLayers.map((l) => l.rid).sort()).toEqual(['h', 'l', 'm']);
  });

  it('separates "asked for" from "actually sending", and says what stopped it', () => {
    const before = report(pair(), layer('h'), { ...SENDING, bytesSent: 100_000 }, layer('l'));
    const s = summarizeStats(report(pair(), layer('h'), SENDING, layer('l')), before, 2000, 1000);
    const byRid = Object.fromEntries(s.outboundLayers.map((l) => [l.rid, l]));

    expect(byRid.m.sending).toBe(true);
    expect(byRid.m.frameWidth).toBe(320);
    expect(byRid.m.frameHeight).toBe(240);

    // Configured and active, but nothing came out of it.
    expect(byRid.h.active).toBe(true);
    expect(byRid.h.sending).toBe(false);
    expect(byRid.h.limitedBy).toBe('bandwidth');
  });

  it('computes each layer rate from its own previous sample', () => {
    const before = report(pair(), layer('h'), SENDING, layer('l'));
    const after = report(
      pair(),
      layer('h'),
      { ...SENDING, bytesSent: 138_500 + 25_000 },
      layer('l')
    );
    const s = summarizeStats(after, before, 2000, 1000);
    const m = s.outboundLayers.find((l) => l.rid === 'm');
    expect(m.kbps).toBeCloseTo(200);          // 25,000 bytes in 1s = 200 kbps
    expect(s.outboundTotalKbps).toBeCloseTo(200);
  });

  // The headline bitrate must agree with the layer table under it.
  it('reports the whole outbound rate, summed across every encoding', () => {
    const before = report(pair(), layer('h', { bytesSent: 0 }), SENDING, layer('l', { bytesSent: 0 }));
    const after = report(
      pair(),
      layer('h', { bytesSent: 50_000 }),
      { ...SENDING, bytesSent: 138_500 + 25_000 },
      layer('l', { bytesSent: 12_500 })
    );
    const s = summarizeStats(after, before, 2000, 1000);
    // 50,000 + 25,000 + 12,500 bytes in one second.
    expect(s.outboundKbps).toBeCloseTo(700);
    expect(s.outboundKbps).toBeCloseTo(s.outboundTotalKbps);
  });

  it('computes packet loss for a sender from what it sent and what RTCP reported lost', () => {
    const s = summarizeStats(
      report(
        pair(),
        { ...SENDING, packetsSent: 1000 },
        layer('h', { packetsSent: 0 }),
        { type: 'remote-inbound-rtp', kind: 'video', id: 'ri-m', packetsLost: 25 }
      ),
      null, 1000, 0
    );
    expect(s.packetsLost).toBe(25);
    expect(s.packetLossPct).toBeCloseTo(2.5);
  });

  it('still uses the receiver denominator when there is an inbound stream', () => {
    const s = summarizeStats(report(pair(), inbound()), null, 1000, 0);
    expect(s.packetLossPct).toBeCloseTo(1);   // 100 lost of 9900 received + 100 lost
  });

  it('stays empty for an ordinary publish, because one encoding is not a layer list', () => {
    const s = summarizeStats(
      report(pair(), { type: 'outbound-rtp', kind: 'video', bytesSent: 1000 }),
      null, 1000, 0
    );
    expect(s.outboundLayers).toEqual([]);
    expect(s.outboundTotalKbps).toBeNull();
  });
});

describe('whether a rung is sending', () => {
  // The rung sent 90,000 bytes earlier in the session and nothing since.
  it('is false for a rung the browser has turned off, whatever it sent before', () => {
    const before = report(pair(), SENDING, layer('h', { bytesSent: 90_000 }));
    const after = report(pair(), SENDING, layer('h', { bytesSent: 90_000 }));
    const h = summarizeStats(after, before, 2000, 1000).outboundLayers.find((l) => l.rid === 'h');
    expect(h.bytesSent).toBe(90_000);
    expect(h.sending).toBe(false);
    expect(h.kbps).toBe(0);
  });

  it('is false for an encoding that is not active, even with bytes moving', () => {
    const before = report(pair(), SENDING, layer('h', { bytesSent: 1000, active: false }));
    const after = report(pair(), SENDING, layer('h', { bytesSent: 5000, active: false }));
    const h = summarizeStats(after, before, 2000, 1000).outboundLayers.find((l) => l.rid === 'h');
    expect(h.sending).toBe(false);
  });

  it('is not known on the first sample, which has no interval to measure', () => {
    const s = summarizeStats(report(pair(), SENDING, layer('h')), null, 1000, 0);
    expect(s.outboundLayers.every((l) => l.sending === null)).toBe(true);
  });
});

describe('packet loss over the last interval', () => {
  // 100 lost of 10,000 earlier, then a clean second: the session figure would still say 1 %.
  it('reads zero for a clean interval after an earlier burst, as a receiver', () => {
    const before = report(pair(), inbound());
    const after = report(pair(), inbound({ packetsReceived: 10_900, packetsLost: 100 }));
    const s = summarizeStats(after, before, 2000, 1000);
    expect(s.packetLossPct).toBe(0);
    expect(s.packetsLost).toBe(100);
  });

  it('measures only what was lost in the interval, as a receiver', () => {
    const before = report(pair(), inbound());
    const after = report(pair(), inbound({ packetsReceived: 10_850, packetsLost: 150 }));
    // 50 lost of 950 received plus 50 lost.
    expect(summarizeStats(after, before, 2000, 1000).packetLossPct).toBeCloseTo(5);
  });

  it('measures only the interval as a sender, too', () => {
    const remote = (lost) => ({ type: 'remote-inbound-rtp', kind: 'video', id: 'ri-m', packetsLost: lost });
    const before = report(pair(), { ...SENDING, packetsSent: 1000 }, remote(25));
    const after = report(pair(), { ...SENDING, packetsSent: 1200 }, remote(25));
    expect(summarizeStats(after, before, 2000, 1000).packetLossPct).toBe(0);

    const worse = report(pair(), { ...SENDING, packetsSent: 1200 }, remote(35));
    expect(summarizeStats(worse, before, 2000, 1000).packetLossPct).toBeCloseTo(5);
  });

  it('does not count a packetsLost that stepped back as negative loss', () => {
    const before = report(pair(), inbound({ packetsLost: 100 }));
    const after = report(pair(), inbound({ packetsReceived: 10_900, packetsLost: 98 }));
    expect(summarizeStats(after, before, 2000, 1000).packetLossPct).toBe(0);
  });
});

describe('jitter buffer over the interval', () => {
  it('has no figure for an interval in which no frame left the buffer', () => {
    const before = report(pair(), inbound());
    const after = report(pair(), inbound());
    const s = summarizeStats(after, before, 2000, 1000);
    expect(s.jitterBufferMs).toBeNull();
    expect(s.latencyIsPartial).toBe(true);
  });

  it('uses only the frames of the interval', () => {
    const before = report(pair(), inbound());
    // 30 more frames that waited 3 s in total: 100 ms each, against a 40 ms session average.
    const after = report(pair(), inbound({ jitterBufferDelay: 15, jitterBufferEmittedCount: 330 }));
    expect(summarizeStats(after, before, 2000, 1000).jitterBufferMs).toBeCloseTo(100);
  });
});

describe('video bitrate', () => {
  const audioOut = (bytesSent) => ({ type: 'outbound-rtp', kind: 'audio', id: 'out-a', bytesSent });

  it('is null on an audio-only publish, while the audio rate is still reported', () => {
    const s = summarizeStats(report(pair(), audioOut(20_000)), report(pair(), audioOut(10_000)), 2000, 1000);
    expect(s.videoKbps).toBeNull();
    expect(s.audioKbps).toBeCloseTo(80);
    expect(s.hasVideo).toBe(false);
  });

  it('is the video rate alone when audio is sent beside it', () => {
    const video = (bytesSent) => ({ type: 'outbound-rtp', kind: 'video', id: 'out-v', bytesSent });
    const s = summarizeStats(
      report(pair(), video(150_000), audioOut(20_000)),
      report(pair(), video(100_000), audioOut(10_000)),
      2000, 1000);
    expect(s.videoKbps).toBeCloseTo(400);
  });
});

describe('rates use the time the browser measured', () => {
  it('divides by the stats timestamps, not by when the poll resolved', () => {
    const first = report(pair(), inbound({ bytesReceived: 1_000_000, timestamp: 10_000 }));
    const second = report(pair(), inbound({ bytesReceived: 1_250_000, timestamp: 12_000 }));
    // The poll saw 500 ms pass; the counters span 2 s.
    expect(summarizeStats(second, first, 1500, 1000).inboundKbps).toBeCloseTo(1000);
  });
});

describe('the candidate pair', () => {
  // After an ICE restart the old pair can stay nominated and succeeded.
  it('is the one the transport names, not the first nominated one', () => {
    const s = summarizeStats(report(
      pair({ id: 'old', currentRoundTripTime: 0.3, localCandidateId: 'lc-old' }),
      pair({ id: 'new', currentRoundTripTime: 0.02, localCandidateId: 'lc-new' }),
      { type: 'transport', id: 't', selectedCandidatePairId: 'new' },
      { type: 'local-candidate', id: 'lc-old', candidateType: 'host' },
      { type: 'local-candidate', id: 'lc-new', candidateType: 'relay' },
    ), null, 1000, 0);
    expect(s.rttMs).toBeCloseTo(20);
    expect(s.localCandidateType).toBe('relay');
  });

  it('falls back to the nominated pair when the transport names none', () => {
    const s = summarizeStats(report(
      pair({ id: 'a', nominated: false, currentRoundTripTime: 0.3 }),
      pair({ id: 'b', currentRoundTripTime: 0.05 }),
    ), null, 1000, 0);
    expect(s.rttMs).toBeCloseTo(50);
  });
});

describe('the headline figures on a simulcast publish', () => {
  const rung = (rid, width, height, bytesSent, over = {}) => layer(rid, {
    frameWidth: width, frameHeight: height, bytesSent, framesPerSecond: 30,
    qualityLimitationReason: 'none', ...over,
  });

  it('come from the largest rung that is sending, whatever order they are listed in', () => {
    const before = report(pair(), rung('l', 320, 180, 1000), rung('h', 1280, 720, 1000), rung('m', 640, 360, 1000));
    const after = report(pair(), rung('l', 320, 180, 2000), rung('h', 1280, 720, 9000), rung('m', 640, 360, 4000));
    const s = summarizeStats(after, before, 2000, 1000);
    expect(s.frameWidth).toBe(1280);
    expect(s.frameHeight).toBe(720);
  });

  it('skip a top rung the browser has stopped, and give the reason from the rung sent', () => {
    const before = report(pair(),
      rung('h', 1280, 720, 5000, { qualityLimitationReason: 'bandwidth' }),
      rung('m', 640, 360, 1000, { qualityLimitationReason: 'bandwidth' }));
    const after = report(pair(),
      rung('h', 1280, 720, 5000, { qualityLimitationReason: 'bandwidth' }),
      rung('m', 640, 360, 4000, { qualityLimitationReason: 'bandwidth' }));
    const s = summarizeStats(after, before, 2000, 1000);
    expect(s.frameWidth).toBe(640);
    expect(s.qualityLimitation).toBe('bandwidth');
  });
});

describe('startStatsPolling', () => {
  afterEach(() => vi.useRealTimers());

  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  };

  it('does not deliver a sample that arrives after it was stopped', async () => {
    const pending = deferred();
    const onSample = vi.fn();
    const stop = startStatsPolling({ getStats: () => pending.promise }, onSample, 1000);
    stop();
    pending.resolve(report(pair()));
    await pending.promise;
    await Promise.resolve();
    expect(onSample).not.toHaveBeenCalled();
  });

  it('does not start a second getStats while one is still running', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const getStats = vi.fn(() => pending.promise);
    const onSample = vi.fn();
    const stop = startStatsPolling({ getStats }, onSample, 1000);
    vi.advanceTimersByTime(3500);
    expect(getStats).toHaveBeenCalledTimes(1);

    pending.resolve(report(pair()));
    await vi.advanceTimersByTimeAsync(0);
    expect(onSample).toHaveBeenCalledTimes(1);
    stop();
  });
});
