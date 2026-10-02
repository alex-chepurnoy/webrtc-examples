import { describe, expect, it } from 'vitest';

import { MAX_SEQUENCE, findSeiPayload } from '../utils/frameStamp';
import { MIN_SAMPLES, TIMER_RESOLUTION_MS, WIDE_RANGE_MS } from './clockSync';
import {
  CLOCK_CHANNEL_LABEL,
  SENT_MEMORY,
  STALE_MS,
  buildClockPing,
  newClockSessionId,
  buildClockReply,
  configureEncodedStreams,
  countMissedFrames,
  decideStamping,
  describeClock,
  frameLatency,
  getSample,
  isOwnFrame,
  isProbeAvailable,
  median,
  mediansOverOneFrameSet,
  nextSequenceFor,
  parseClockMessage,
  probeUnavailableReason,
  recordSentStamp,
  resetProbe,
  stampFrameBytes,
  subscribe,
  summarizeProbe,
} from './latencyProbe';

// The state shape summarizeProbe reads, spelled out because createState is private.
const stateWith = (overrides = {}) => ({
  senderStatus: 'off',
  senderReason: null,
  stampedOut: 0,
  receiverStatus: 'reading',
  receiverReason: null,
  frames: [],
  byRtpTimestamp: new Map(),
  stampedFrames: 0,
  unstampedFrames: 0,
  missedFrames: 0,
  lastSequence: null,
  lastFrameAt: null,
  joinedFrames: 0,
  clockSamples: [],
  ...overrides,
});

/* One received frame, with both legs measurable unless a field is nulled out. */
const record = ({
  sequence = 1, sentAt = 1_000_000, transportMs = 100, playerMs = 20, rtpTimestamp = 90_000,
  own = false,
} = {}) => ({
  sequence,
  sentAt,
  own,
  arrivedAt: sentAt + transportMs,
  arrivedAtHighRes: 5_000,
  rtpTimestamp,
  displayAtHighRes: playerMs === null ? null : 5_000 + playerMs,
});

// A round trip to a far end offsetMs ahead, replying instantly so the round trip is exactly
// rttMs. Same construction as clockSync.test.js, so the two agree on what a sample is.
const roundTrip = ({ offsetMs = 0, rttMs = 20, t0 = 1_000_000 } = {}) => {
  const t1 = t0 + rttMs / 2 + offsetMs;
  return { t0, t1, t2: t1, t3: t0 + rttMs };
};

const repeat = (count, make) => Array.from({ length: count }, (_unused, index) => make(index));

describe('decideStamping', () => {
  it('stamps an H.264 sender, however the mime type is spelled', () => {
    for (const mimeType of ['video/H264', 'video/h264', 'video/AVC1']) {
      expect(decideStamping(mimeType, null)).toEqual({ stamp: true, resolved: true, reason: null });
    }
  });

  // An SEI NAL corrupts a VP8 frame, so a non-H.264 codec must be a refusal.
  it('refuses a codec that has no SEI, and says which one it saw', () => {
    const decision = decideStamping('video/VP8', 'H264');
    expect(decision.stamp).toBe(false);
    expect(decision.resolved).toBe(true);
    expect(decision.reason).toContain('video/VP8');
  });

  it('treats the page setting as provisional, so the decision is taken again', () => {
    expect(decideStamping(null, 'H264')).toEqual({ stamp: true, resolved: false, reason: null });
  });

  it('does not stamp when nothing has said H.264 yet', () => {
    const decision = decideStamping(null, undefined);
    expect(decision.stamp).toBe(false);
    expect(decision.resolved).toBe(false);
    expect(decision.reason).toContain('negotiated video codec');
  });
});

describe('countMissedFrames', () => {
  it('counts nothing between consecutive frames', () => {
    expect(countMissedFrames(41, 42)).toBe(0);
  });

  it('counts the frames a gap skipped', () => {
    expect(countMissedFrames(10, 14)).toBe(3);
  });

  it('counts nothing for a repeat or a reordered pair', () => {
    expect(countMissedFrames(42, 42)).toBe(0);
    expect(countMissedFrames(42, 40)).toBe(0);
  });

  it('counts across the 32-bit wrap instead of inventing four billion losses', () => {
    expect(countMissedFrames(MAX_SEQUENCE, 0)).toBe(0);
    // MAX_SEQUENCE and 0 are the two frames between these, so two were missed.
    expect(countMissedFrames(MAX_SEQUENCE - 1, 1)).toBe(2);
  });

  // Exactly half the space is as likely a step back as a step forward, so it is not loss.
  it('counts nothing for a jump of exactly half the sequence space', () => {
    expect(countMissedFrames(0, 2 ** 31)).toBe(0);
    expect(countMissedFrames(2 ** 31, 0)).toBe(0);
    expect(countMissedFrames(0, 2 ** 31 - 1)).toBe(2 ** 31 - 2);
  });

  it('counts nothing when either side is not a sequence number', () => {
    expect(countMissedFrames(null, 5)).toBe(0);
    expect(countMissedFrames(5, undefined)).toBe(0);
  });
});

describe('stampFrameBytes', () => {
  // Sender and receiver halves meeting over the real frameStamp codec, frame intact behind it.
  it('writes a stamp the receiver half reads back, ahead of the frame it was given', () => {
    // An IDR slice with a payload that contains 00 00 01, which is the emulation-prevention trap.
    const frame = Uint8Array.from([
      0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x00, 0x00, 0x01, 0x42, 0xff,
    ]);
    const stamp = { sequence: 77, sentAt: 1_726_600_000_123, rung: 1 };
    const stamped = stampFrameBytes(frame.buffer, stamp);

    expect(findSeiPayload(stamped)).toEqual(stamp);

    const bytes = new Uint8Array(stamped);
    expect(bytes.slice(bytes.length - frame.length)).toEqual(frame);
    expect(bytes.length).toBeGreaterThan(frame.length);
  });

  it('leaves the frame it was handed alone, so a pass-through frame is never corrupted', () => {
    const frame = Uint8Array.from([0x00, 0x00, 0x00, 0x01, 0x41, 0x9a]);
    const before = Uint8Array.from(frame);
    stampFrameBytes(frame.buffer, { sequence: 1, sentAt: 2 });
    expect(frame).toEqual(before);
  });

  // The provisional decision says stamp before negotiation; the frame itself still has to agree.
  it('refuses a frame that is not H.264, whatever the decision said', () => {
    const vp8Key = Uint8Array.from([0x50, 0x42, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01]);
    expect(stampFrameBytes(vp8Key.buffer, { sequence: 1, sentAt: 2 })).toBeNull();
    // An HEVC keyframe opens with a VPS, header 0x40 0x01, which is not an H.264 NAL here.
    const hevcKey = Uint8Array.from([0x00, 0x00, 0x00, 0x01, 0x40, 0x01, 0x0c, 0x01, 0xff]);
    expect(stampFrameBytes(hevcKey.buffer, { sequence: 1, sentAt: 2 })).toBeNull();
  });
});

describe('nextSequenceFor', () => {
  it('counts each simulcast rung on its own, so one rung arrives contiguous', () => {
    const counters = new Map();
    expect(nextSequenceFor(counters, 'h')).toBe(0);
    expect(nextSequenceFor(counters, 'l')).toBe(0);
    expect(nextSequenceFor(counters, 'h')).toBe(1);
    expect(nextSequenceFor(counters, 'h')).toBe(2);
    expect(nextSequenceFor(counters, 'l')).toBe(1);

    // What the player subscribed to one rung actually sees: no gaps.
    expect(countMissedFrames(1, 2)).toBe(0);
  });

  it('wraps at the width of the field the stamp carries', () => {
    const counters = new Map([['single', MAX_SEQUENCE]]);
    expect(nextSequenceFor(counters, 'single')).toBe(MAX_SEQUENCE);
    expect(nextSequenceFor(counters, 'single')).toBe(0);
  });
});

describe('median', () => {
  it('returns a value that was actually observed', () => {
    expect(median([10, 20, 30, 40])).toBe(20);
    expect(median([30, 10, 20])).toBe(20);
  });

  it('ignores the frames that had no figure rather than counting them as zero', () => {
    expect(median([null, 100, null, 102, 104])).toBe(102);
  });

  it('returns null when there is nothing to report', () => {
    expect(median([])).toBe(null);
    expect(median([null, undefined, Number.NaN])).toBe(null);
  });
});

describe('describeClock', () => {
  it('reports how far it is from having an answer while the window fills', () => {
    const clock = describeClock(repeat(MIN_SAMPLES - 1, () => roundTrip({ rttMs: 10 })));
    expect(clock.state).toBe('unknown');
    expect(clock.offsetMs).toBe(null);
    expect(clock.warming).toBe(true);
    expect(clock.resyncing).toBe(false);
    expect(clock.reason).toBe(`Exchanging clock samples (${MIN_SAMPLES - 1} of ${MIN_SAMPLES}).`);
  });

  it('calls an offset of zero on a tight path exact rather than estimated', () => {
    const clock = describeClock(repeat(10, () => roundTrip({ rttMs: 1, offsetMs: 0 })));
    expect(clock.state).toBe('ok');
    expect(clock.exact).toBe(true);
    expect(clock.mode).toBe('same-clock');
    expect(clock.offsetMs).toBe(0);
    // Half the round trip, the padding on each side, and one more resolution for the stamp pair.
    expect(clock.uncertaintyMs).toBeCloseTo(0.5 + 2 * TIMER_RESOLUTION_MS, 2);
  });

  // One browser is claimed only on proof that the frames are this page's own.
  it('names one browser only when the frames are proven to be this page\'s own', () => {
    const samples = repeat(10, () => roundTrip({ rttMs: 1, offsetMs: 0 }));
    expect(describeClock(samples, { sameContext: true }).mode).toBe('same-context');
    expect(describeClock(samples, { sameContext: false }).mode).toBe('same-clock');
  });

  it('reports a real offset as estimated across machines, with its bound', () => {
    const clock = describeClock(repeat(10, (i) => roundTrip({ rttMs: 20 + i, offsetMs: 4_000 })));
    expect(clock.state).toBe('ok');
    expect(clock.exact).toBe(false);
    expect(clock.mode).toBe('cross-machine');
    expect(clock.offsetMs).toBeCloseTo(4_000, 2);
    expect(clock.uncertaintyMs).toBeCloseTo(10 + 2 * TIMER_RESOLUTION_MS, 1);
  });

  it('never claims one clock while the samples disagree', () => {
    const scattered = repeat(10, (i) => roundTrip({ rttMs: 4, offsetMs: i % 2 === 0 ? 0 : 900 }));
    expect(describeClock(scattered).exact).toBe(false);
    expect(describeClock(scattered).mode).toBe(null);
  });

  // With the topology proven, the offset is zero by construction, not by estimate.
  it('forces the offset to exactly zero in one context, whatever the samples say', () => {
    const scattered = repeat(10, (i) => roundTrip({ rttMs: 4, offsetMs: i % 2 === 0 ? 0 : 900 }));
    const clock = describeClock(scattered, { sameContext: true });
    expect(clock.state).toBe('ok');
    expect(clock.offsetMs).toBe(0);
    expect(clock.exact).toBe(true);
    expect(describeClock([], { sameContext: true }).offsetMs).toBe(0);
  });

  // The first seconds of a session are not a failure and must not read as one.
  it('marks the first seconds as warming up, counting only usable samples', () => {
    const junk = repeat(MIN_SAMPLES, () => null);
    const clock = describeClock([...junk, ...repeat(MIN_SAMPLES - 1, () => roundTrip())]);
    expect(clock.warming).toBe(true);
    expect(clock.reason).toBe(`Exchanging clock samples (${MIN_SAMPLES - 1} of ${MIN_SAMPLES}).`);
  });

  // The old design refused above 30 ms; a long path is a wide range, answered and flagged.
  it('answers over a long path with a wide range and says it is wide', () => {
    const rttMs = (WIDE_RANGE_MS + 5) * 2;
    const clock = describeClock(repeat(10, () => roundTrip({ rttMs, offsetMs: 500 })));
    expect(clock.state).toBe('ok');
    expect(clock.reason).toBe(null);
    expect(clock.wide).toBe(true);
    expect(clock.offsetMs).toBeCloseTo(500, 2);
    expect(clock.uncertaintyMs).toBeGreaterThan(WIDE_RANGE_MS);
  });

  // A steady round trip of a couple of milliseconds with offset zero is one clock, at any age
  // the 1 s ping cadence produces; three milliseconds is already a range.
  it('keeps exact for round trips of 0 to 2 ms up to a second old, and not for 3 ms', () => {
    const at = (rttMs, ageMs) => describeClock(
      repeat(10, () => ({ ...roundTrip({ rttMs, offsetMs: 0 }), m3: 5_000 })),
      { monoNow: 5_000 + ageMs },
    );
    for (const rttMs of [0, 1, 2]) {
      for (const ageMs of [0, 500, 1_000]) {
        expect(at(rttMs, ageMs).exact, `rtt ${rttMs} age ${ageMs}`).toBe(true);
      }
    }
    for (const ageMs of [0, 1_000]) {
      const clock = at(3, ageMs);
      expect(clock.exact, `rtt 3 age ${ageMs}`).toBe(false);
      expect(clock.mode).toBe('cross-machine');
    }
  });

  it('does not call a tight range wide', () => {
    const clock = describeClock(repeat(10, () => roundTrip({ rttMs: 20, offsetMs: 500 })));
    expect(clock.wide).toBe(false);
  });

  // Two ways to have no range, told apart: not enough samples yet, and the clocks having moved.
  it('says the clocks moved when enough samples exist but too few agree', () => {
    const scattered = repeat(10, (i) => roundTrip({ rttMs: 4, offsetMs: i % 2 === 0 ? 0 : 900 }));
    const clock = describeClock(scattered);
    expect(clock.state).toBe('unknown');
    expect(clock.warming).toBe(false);
    expect(clock.resyncing).toBe(true);
    expect(clock.stepAgeMs).not.toBeNull();
    expect(clock.reason).toContain('syncing again');
  });

  // A silent clock channel widens the range with the monotonic age of the newest sample.
  it('reports the age of the newest sample and widens the range for it', () => {
    const samples = repeat(10, () => roundTrip({ rttMs: 20, offsetMs: 500, t0: 1_000_000 }))
      .map((sample) => ({ ...sample, m3: 5_000 }));
    const fresh = describeClock(samples, { monoNow: 5_000 });
    const silent = describeClock(samples, { monoNow: 5_000 + 30_000 });

    expect(fresh.ageMs).toBe(0);
    expect(silent.ageMs).toBe(30_000);
    expect(silent.uncertaintyMs).toBeGreaterThan(fresh.uncertaintyMs + 7);
  });

  it('has no refusal state and no "too uncertain" wording for any round trip', () => {
    for (const rttMs of [1, 50, 500, 5_000, 60_000]) {
      const clock = describeClock(repeat(10, () => roundTrip({ rttMs, offsetMs: 500 })));
      expect(clock.state).toBe('ok');
      expect(JSON.stringify(clock)).not.toMatch(/untrusted|too uncertain/);
    }
  });
});

describe('frameLatency', () => {
  it('converts the publisher clock to ours before subtracting', () => {
    // The publisher's clock reads 4,000 ms ahead, so its 1,004,000 is our 1,000,000.
    const frame = frameLatency(
      {
        sentAt: 1_004_000, arrivedAt: 1_000_100, arrivedAtHighRes: 500, displayAtHighRes: 520,
      },
      4_000,
    );
    expect(frame.transportMs).toBe(100);
    expect(frame.playerMs).toBe(20);
    expect(frame.totalMs).toBe(120);
  });

  it('withholds the transport leg when the offset is unknown, and keeps the local one', () => {
    const frame = frameLatency(record({ transportMs: 100, playerMs: 20 }), null);
    expect(frame.transportMs).toBe(null);
    expect(frame.totalMs).toBe(null);
    expect(frame.playerMs).toBe(20);
  });

  it('withholds the player leg for a frame that has not been presented yet', () => {
    const frame = frameLatency(record({ playerMs: null }), 0);
    expect(frame.transportMs).toBe(100);
    expect(frame.playerMs).toBe(null);
    expect(frame.totalMs).toBe(null);
  });
});

describe('summarizeProbe', () => {
  const exactClock = repeat(10, () => roundTrip({ rttMs: 1, offsetMs: 0 }));

  it('is off when no receiver is attached', () => {
    const sample = summarizeProbe(stateWith({ receiverStatus: 'off' }), 1_000);
    expect(sample.status).toBe('off');
    expect(sample.transportMs).toBe(null);
  });

  it('says it is waiting before any frame arrives', () => {
    expect(summarizeProbe(stateWith(), 1_000).status).toBe('waiting');
  });

  // The case an operator hits most often, and it must never look like a bug.
  it('names every cause when frames arrive with no stamp', () => {
    const sample = summarizeProbe(stateWith({ unstampedFrames: 90 }), 1_000);
    expect(sample.status).toBe('no-stamp');
    expect(sample.reason).toContain('probe off');
    expect(sample.reason).toContain('transcoding');
    expect(sample.reason).toContain('H.264');
    expect(sample.totalMs).toBe(null);
  });

  it('marks a stream that stopped as stalled, keeping its last real figures', () => {
    const state = stateWith({
      stampedFrames: 5,
      lastFrameAt: 10_000,
      frames: [record()],
      clockSamples: exactClock,
    });
    const sample = summarizeProbe(state, 10_000 + STALE_MS + 1);
    expect(sample.status).toBe('stalled');
    expect(sample.transportMs).toBe(100);
    expect(sample.reason).toContain('No stamped frame for');
  });

  // Rows over different frames do not describe one path, so all three use the same frames.
  it('takes all three medians over the frames that have both legs', () => {
    const joined = [100, 110, 120].map((transportMs, index) => record({
      sequence: index, transportMs, playerMs: 20 + index, rtpTimestamp: 90_000 + index,
    }));
    // Fast frames the display join has not reached: they must not pull the transport median.
    const notYetShown = [10, 10, 10, 10].map((transportMs, index) => record({
      sequence: 10 + index, transportMs, playerMs: null, rtpTimestamp: 91_000 + index,
    }));
    const frames = [...joined, ...notYetShown];
    const sample = summarizeProbe(stateWith({
      stampedFrames: frames.length, lastFrameAt: 1_000, frames, clockSamples: exactClock,
    }), 1_000);

    expect(sample.transportMs).toBe(110);
    expect(sample.playerMs).toBe(21);
    expect(sample.totalMs).toBe(131);
    expect(sample.figureFrames).toBe(3);
  });

  it('falls back to one leg, with no total, when no frame has both', () => {
    const figures = mediansOverOneFrameSet([
      { transportMs: 90, playerMs: null, totalMs: null },
      { transportMs: 95, playerMs: null, totalMs: null },
    ]);
    expect(figures).toEqual({ transportMs: 90, playerMs: null, totalMs: null, figureFrames: 2 });
  });

  it('reports the median of the window, not the last frame or the mean', () => {
    const frames = [80, 100, 120, 1_400].map((transportMs, index) => record({
      sequence: index, transportMs, playerMs: 20, rtpTimestamp: 90_000 + index,
    }));
    const state = stateWith({
      stampedFrames: frames.length, lastFrameAt: 1_000, frames, clockSamples: exactClock,
    });
    const sample = summarizeProbe(state, 1_000);

    expect(sample.status).toBe('measuring');
    expect(sample.transportMs).toBe(100);
    expect(sample.playerMs).toBe(20);
    expect(sample.totalMs).toBe(120);
    expect(sample.clock.exact).toBe(true);
    expect(sample.reason).toBe(null);
  });

  it('still reports the player leg when the clock offset cannot be measured', () => {
    const state = stateWith({
      stampedFrames: 1,
      lastFrameAt: 1_000,
      frames: [record({ playerMs: 25 })],
      clockSamples: [],
    });
    const sample = summarizeProbe(state, 1_000);

    expect(sample.status).toBe('measuring');
    expect(sample.playerMs).toBe(25);
    expect(sample.transportMs).toBe(null);
    expect(sample.totalMs).toBe(null);
    // The reason the transport row is empty travels with the sample, not in a console log.
    expect(sample.reason).toContain('Exchanging clock samples');
  });

  it('carries the missed-frame count and the sender state through every status', () => {
    const state = stateWith({
      missedFrames: 7,
      lastSequence: 412,
      senderStatus: 'stamping',
      stampedOut: 900,
      unstampedFrames: 3,
    });
    const sample = summarizeProbe(state, 1_000);
    expect(sample.missedFrames).toBe(7);
    expect(sample.lastSequence).toBe(412);
    expect(sample.sender).toEqual({ status: 'stamping', reason: null, stampedFrames: 900 });
  });
});

describe('the clock messages', () => {
  it('round trips a ping and its reply', () => {
    const ping = parseClockMessage(buildClockPing({ sequence: 4, t0: 1_700_000_000_123, id: 77 }));
    expect(ping).toEqual({ kind: 'ping', sequence: 4, t0: 1_700_000_000_123, id: 77 });

    const reply = parseClockMessage(buildClockReply({ ping, t1: 50, t2: 51 }));
    expect(reply).toEqual({
      kind: 'reply', sequence: 4, t0: 1_700_000_000_123, t1: 50, t2: 51, id: 77,
    });
  });

  // Replies are mirrored to every viewer and sequences start at zero on each, so only the id
  // stops two viewers taking each other's replies.
  it('carries the asker through the reply, so viewers do not take each other for themselves', () => {
    const mine = parseClockMessage(buildClockPing({ sequence: 1, t0: 10, id: 111 }));
    const theirs = parseClockMessage(buildClockPing({ sequence: 1, t0: 10, id: 222 }));

    expect(parseClockMessage(buildClockReply({ ping: mine, t1: 11, t2: 12 })).id).toBe(111);
    expect(parseClockMessage(buildClockReply({ ping: theirs, t1: 11, t2: 12 })).id).toBe(222);
  });

  it('gives every initiator a different id', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newClockSessionId()));
    expect(ids.size).toBeGreaterThan(190);
  });

  // A message from a build without the id reads as id null, which is nobody's.
  it('reports no id rather than inventing one', () => {
    const older = JSON.stringify({ wz: 'wz-clock', v: 1, seq: 2, t0: 5 });
    expect(parseClockMessage(older).id).toBeNull();
  });

  // The split view runs both arms on one channel, so answering replies would answer itself.
  it('tells a reply from a ping so the responder never answers itself', () => {
    const reply = buildClockReply({ ping: { sequence: 1, t0: 10, id: 1 }, t1: 11, t2: 12 });
    expect(parseClockMessage(reply).kind).toBe('reply');
  });

  it('ignores anything that is not ours', () => {
    expect(parseClockMessage('hello')).toBe(null);
    expect(parseClockMessage('{"wz":"other","v":1,"seq":1,"t0":1}')).toBe(null);
    expect(parseClockMessage('{"wz":"wz-clock","v":99,"seq":1,"t0":1}')).toBe(null);
    expect(parseClockMessage('{"wz":"wz-clock","v":1,"seq":1}')).toBe(null);
    expect(parseClockMessage('{"wz":"wz-clock","v":1,"seq":"one","t0":1}')).toBe(null);
    expect(parseClockMessage(new ArrayBuffer(8))).toBe(null);
    expect(parseClockMessage(null)).toBe(null);
  });

  it('keeps the channel label in one place', () => {
    expect(CLOCK_CHANNEL_LABEL).toBe('wz-clock');
  });
});

describe('availability', () => {
  // jsdom has no RTCRtpSender, the same answer a non-Chromium browser gives.
  it('refuses with a reason where insertable streams do not exist', () => {
    expect(isProbeAvailable()).toBe(false);
    expect(probeUnavailableReason()).toContain('insertable streams');
  });

  it('does not put the flag on a peer-connection config it cannot honor', () => {
    const config = { iceServers: [] };
    expect(configureEncodedStreams(config, true)).toBe(false);
    expect(config.encodedInsertableStreams).toBe(undefined);
  });

  it('leaves the config alone when the probe is off', () => {
    const config = { iceServers: [] };
    expect(configureEncodedStreams(config, false)).toBe(false);
    expect(config).toEqual({ iceServers: [] });
  });
});

describe('the subscription', () => {
  // Null, not a sample of nulls, so "never measured" cannot be mistaken for a latency.
  it('publishes null while nothing has been measured', () => {
    resetProbe();
    let seen = 'untouched';
    const unsubscribe = subscribe((next) => { seen = next; });
    expect(seen).toBe(null);
    unsubscribe();
  });

  it('still describes why there is no figure, for a caller that asks', () => {
    resetProbe();
    const current = getSample();
    expect(current.status).toBe('off');
    expect(current.transportMs).toBe(null);
    expect(current.clock.exact).toBe(false);
  });

  it('stops delivering once unsubscribed', () => {
    let count = 0;
    const unsubscribe = subscribe(() => { count += 1; });
    expect(count).toBe(1);
    unsubscribe();
    resetProbe();
    expect(count).toBe(1);
  });
});

/*
 * The combined page stamps and reads with one Date.now, but its clock samples still round-trip
 * through the Engine, which gives a wide range. One context is proven by the frames themselves,
 * never by the page merely having a publisher running.
 */
describe('one page that both stamps and reads', () => {
  // A wide bound around an offset of zero: the samples agree, the path is just slow.
  const slowButZero = repeat(10, () => roundTrip({ rttMs: WIDE_RANGE_MS * 3, offsetMs: 0 }));

  const measuring = (overrides) => stateWith({
    stampedFrames: 3, lastFrameAt: 1_000, senderStatus: 'stamping', ...overrides,
  });

  it('is a wide range, not exact, when nothing says the two ends share a context', () => {
    const clock = describeClock(slowButZero);
    expect(clock.state).toBe('ok');
    expect(clock.mode).toBe('cross-machine');
    expect(clock.wide).toBe(true);
    expect(clock.exact).toBe(false);
  });

  it('is exact when every frame in the window is one this page stamped', () => {
    const frames = repeat(3, (i) => record({ sequence: i, own: true, rtpTimestamp: 90_000 + i }));
    const sample = summarizeProbe(measuring({ frames, clockSamples: slowButZero }), 1_000);
    expect(sample.clock.state).toBe('ok');
    expect(sample.clock.exact).toBe(true);
    expect(sample.clock.mode).toBe('same-context');
    expect(sample.transportMs).toBe(100);
  });

  // The reviewer's case: a stamping page playing another machine's stream whose clock is 20 ms
  // ahead, over a path of 20 ms out and 60 ms back. The estimate lands on 0 by accident.
  it('does not call a cross-machine clock exact because this page is also stamping', () => {
    const t0 = 1_000_000;
    const asymmetric = repeat(10, (i) => {
      const start = t0 + i * 1_000;
      const t1 = start + 20 + 20;
      return { t0: start, t1, t2: t1, t3: start + 20 + 60 };
    });
    const frames = repeat(3, (i) => record({ sequence: i, own: false, rtpTimestamp: 90_000 + i }));
    const sample = summarizeProbe(measuring({ frames, clockSamples: asymmetric }), 1_000);

    expect(sample.clock.exact).toBe(false);
    expect(sample.clock.mode).not.toBe('same-context');
    expect(sample.clock.state).toBe('ok');
    expect(sample.clock.mode).toBe('cross-machine');
    // Half the 80 ms round trip, the padding on each side, and one more resolution for the stamps.
    expect(sample.clock.uncertaintyMs).toBeCloseTo(40 + 2 * TIMER_RESOLUTION_MS, 1);
    // The estimate lands on 0 by accident; the figure carries the range that says so.
    expect(sample.transportMs).toBeCloseTo(100, 1);
  });

  it('is not exact while even one frame in the window came from somewhere else', () => {
    const frames = [
      record({ sequence: 1, own: true }),
      record({ sequence: 2, own: false, rtpTimestamp: 90_001 }),
    ];
    const sample = summarizeProbe(measuring({ frames, clockSamples: slowButZero }), 1_000);
    expect(sample.clock.mode).not.toBe('same-context');
  });
});

describe('recognizing this page\'s own frames', () => {
  it('matches rung, sequence and send time, and nothing less', () => {
    const sent = new Map();
    recordSentStamp(sent, { rung: 1, sequence: 7, sentAt: 1_000 });
    expect(isOwnFrame(sent, { rung: 1, sequence: 7, sentAt: 1_000 })).toBe(true);
    expect(isOwnFrame(sent, { rung: 1, sequence: 7, sentAt: 1_001 })).toBe(false);
    expect(isOwnFrame(sent, { rung: 0, sequence: 7, sentAt: 1_000 })).toBe(false);
    expect(isOwnFrame(null, { rung: 1, sequence: 7, sentAt: 1_000 })).toBe(false);
  });

  it('remembers a bounded number of stamps, oldest out first', () => {
    const sent = new Map();
    for (let sequence = 0; sequence <= SENT_MEMORY; sequence += 1) {
      recordSentStamp(sent, { rung: 0, sequence, sentAt: sequence });
    }
    expect(sent.size).toBe(SENT_MEMORY);
    expect(isOwnFrame(sent, { rung: 0, sequence: 0, sentAt: 0 })).toBe(false);
    expect(isOwnFrame(sent, { rung: 0, sequence: SENT_MEMORY, sentAt: SENT_MEMORY })).toBe(true);
  });
});
