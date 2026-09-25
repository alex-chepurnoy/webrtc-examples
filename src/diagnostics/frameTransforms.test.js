import { describe, expect, it } from 'vitest';

import { findSeiPayload } from '../utils/frameStamp';
import { createFrameStamper, readFrame } from './frameTransforms';

const START = [0x00, 0x00, 0x00, 0x01];
const keyframe = () => Uint8Array.from([
  ...START, 0x67, 0x42, 0xc0, 0x1f, ...START, 0x68, 0xce, 0x3c, 0x80, ...START, 0x65, 0x88, 0x84,
]).buffer;
const deltaFrame = () => Uint8Array.from([...START, 0x41, 0x9a, 0x24]).buffer;

/* An RTCEncodedVideoFrame stand-in: data, and the metadata Chromium reports per rung. */
const encoded = (data, metadata = {}) => ({ data, getMetadata: () => metadata });

describe('createFrameStamper', () => {
  it('writes a stamp the reader finds, and reports what it wrote', () => {
    const stamp = createFrameStamper({ now: () => 1_726_600_000_000 });
    const frame = encoded(keyframe(), { synchronizationSource: 111 });

    const sent = stamp(frame, true);
    expect(sent).toEqual({ rung: 0, sequence: 0, sentAt: 1_726_600_000_000 });
    expect(findSeiPayload(frame.data)).toEqual(sent);
  });

  // The rung byte is what lets the player keep a baseline per rung; nonzero must survive.
  it('numbers rungs by SSRC in order of appearance, each with its own sequence', () => {
    const stamp = createFrameStamper({ now: () => 5 });
    const sent = [
      stamp(encoded(deltaFrame(), { synchronizationSource: 111 }), true),
      stamp(encoded(deltaFrame(), { synchronizationSource: 222 }), true),
      stamp(encoded(deltaFrame(), { synchronizationSource: 333 }), true),
      stamp(encoded(deltaFrame(), { synchronizationSource: 222 }), true),
    ];
    expect(sent.map(({ rung, sequence }) => [rung, sequence])).toEqual([[0, 0], [1, 0], [2, 0], [1, 1]]);
  });

  it('leaves the frame alone when stamping is not wanted, or the frame is not H.264', () => {
    const stamp = createFrameStamper();
    const off = encoded(deltaFrame());
    const before = off.data;
    expect(stamp(off, false)).toBeNull();
    expect(off.data).toBe(before);

    const vp8 = encoded(Uint8Array.from([0x50, 0x42, 0x00, 0x9d, 0x01, 0x2a]).buffer);
    expect(stamp(vp8, true)).toBeNull();
    expect(findSeiPayload(vp8.data)).toBeNull();

    // A refused frame consumes no sequence number.
    expect(stamp(encoded(deltaFrame()), true).sequence).toBe(0);
  });

  it('says once, with the layout, when it cannot stamp a frame it was asked to', () => {
    const refused = [];
    const stamp = createFrameStamper({ onRefused: (layout) => refused.push(layout) });
    const odd = () => encoded(Uint8Array.from([...START, 0x7f, 0x01, ...START, 0x41, 0x9a]).buffer);
    stamp(odd(), true);
    stamp(odd(), true);
    stamp(odd(), false);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/NAL 31\/3/);
  });
});

describe('readFrame', () => {
  it('reads the stamp, the join key and both clocks', () => {
    const stamp = createFrameStamper({ now: () => 42 });
    const frame = encoded(keyframe(), { synchronizationSource: 9, rtpTimestamp: 90_000 });
    stamp(frame, true);

    const read = readFrame(frame);
    expect(read.stamp).toEqual({ rung: 0, sequence: 0, sentAt: 42 });
    expect(read.rtpTimestamp).toBe(90_000);
    expect(Number.isInteger(read.arrivedAt)).toBe(true);
    expect(read.arrivedAtAbs).toBeGreaterThan(performance.timeOrigin);
  });

  it('says only that there was no stamp on an unstamped frame', () => {
    expect(readFrame(encoded(deltaFrame()))).toEqual({ stamp: null });
  });
});
