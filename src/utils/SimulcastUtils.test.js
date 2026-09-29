import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SIMULCAST_RENDITIONS,
  MAX_SIMULCAST_RENDITIONS,
  SIMULCAST_LIMIT_REASON,
  getSimulcastRenditionsError,
  parseSimulcastRenditions,
} from './SimulcastUtils';

// The table calls the rid "Rendition ID", so the messages about it do too.
describe('getSimulcastRenditionsError', () => {
  it('accepts the default ladder', () => {
    expect(getSimulcastRenditionsError(DEFAULT_SIMULCAST_RENDITIONS)).toBeNull();
  });

  it('names the Rendition ID, not the RID', () => {
    const bad = getSimulcastRenditionsError([{ rid: 'a b', scaleResolutionDownBy: 1, maxBitrate: 1 }]);
    expect(bad).toBe('Invalid Rendition ID "a b": use only letters, numbers, - and _');
    const long = getSimulcastRenditionsError([{ rid: 'x'.repeat(17), scaleResolutionDownBy: 1, maxBitrate: 1 }]);
    expect(long).toMatch(/^Invalid Rendition ID ".*": maximum length is 16$/);
    const dup = getSimulcastRenditionsError([
      { rid: 'h', scaleResolutionDownBy: 1, maxBitrate: 1 },
      { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 1 },
    ]);
    expect(dup).toBe('Duplicate Rendition ID: h');
    for (const message of [bad, long, dup]) expect(message).not.toMatch(/\bRID\b/);
  });

  it('states the bitrate unit the table shows', () => {
    expect(getSimulcastRenditionsError([{ rid: 'h', scaleResolutionDownBy: 1, maxBitrate: 0 }]))
      .toBe('Invalid max bitrate for "h": must be greater than 0 kbps');
  });

  it('caps the ladder, and says why', () => {
    const four = ['a', 'b', 'c', 'd'].map((rid) => ({ rid, scaleResolutionDownBy: 1, maxBitrate: 1 }));
    expect(getSimulcastRenditionsError(four)).toMatch(/maximum of 3/);
    expect(MAX_SIMULCAST_RENDITIONS).toBe(3);
    expect(SIMULCAST_LIMIT_REASON).toMatch(/Chrome encodes at most 3 simulcast layers/);
  });
});

describe('parseSimulcastRenditions', () => {
  // The cookie and share link hold bps, and still do now the table shows kbps.
  it('restores a saved ladder in bps unchanged', () => {
    const restored = parseSimulcastRenditions(JSON.stringify([
      { rid: 'h', scaleResolutionDownBy: 1, maxBitrate: 2500000 },
      { rid: 'l', scaleResolutionDownBy: 4, maxBitrate: 200000 },
    ]));
    expect(restored.map((r) => r.maxBitrate)).toEqual([2500000, 200000]);
  });
});
