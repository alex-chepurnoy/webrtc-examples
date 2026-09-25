/*
 * The per-frame work of the latency probe: writing the stamp on the publisher and reading it on
 * the player. Shared by the worker (latencyProbeWorker.js) and the main-thread fallback in
 * latencyProbe.js, so it imports nothing but the stamp codec: no DOM, no store, no logging.
 */

import {
  MAX_RUNG,
  MAX_SEQUENCE,
  describeFrameLayout,
  findSeiPayload,
  insertStamp,
  stampInsertionOffset,
} from '../utils/frameStamp';

// The sequence space the stamp's 32-bit field can carry.
const SEQUENCE_SPACE = MAX_SEQUENCE + 1;

/**
 * The next sequence number for one simulcast rung. `counters` is mutated.
 *
 * Per rung because the sender's stream carries every rung while the player receives one, so a
 * shared counter shows up as false missed frames. The caller keys on synchronizationSource:
 * Chromium reports rid undefined and spatialIndex 0 on every rung, so only the SSRC differs.
 */
export const nextSequenceFor = (counters, key) => {
  const value = counters.get(key) ?? 0;
  counters.set(key, (value + 1) % SEQUENCE_SPACE);
  return value;
};

/**
 * A one-byte index for a rung, in order of first appearance; this, not the SSRC, travels in the
 * stamp. `indices` is mutated. Clamped at MAX_RUNG so a key never exceeds what the stamp holds.
 */
export const rungIndexFor = (indices, key) => {
  const existing = indices.get(key);
  if (existing !== undefined) return existing;
  const next = Math.min(indices.size, MAX_RUNG);
  indices.set(key, next);
  return next;
};

/**
 * An encoded frame with the stamp inserted in front of its first slice, as a fresh ArrayBuffer,
 * or null when the bytes do not parse as H.264 (see insertStamp). The SEI is a NAL of its own,
 * so the existing bitstream is untouched and the decoder may ignore it.
 */
export const stampFrameBytes = (frameData, { sequence, sentAt, rung = 0 }) => {
  const stamped = insertStamp(new Uint8Array(frameData), { sequence, sentAt, rung });
  return stamped === null ? null : stamped.buffer;
};

const metadataOf = (frame) => (typeof frame.getMetadata === 'function' ? frame.getMetadata() : null);

/*
 * SSRC is the field that differs per rung (see nextSequenceFor); rid and spatialIndex are
 * fallbacks for a browser that fills them.
 */
const rungKeyOf = (metadata) => metadata?.synchronizationSource
  ?? metadata?.rid
  ?? metadata?.spatialIndex
  ?? 'single';

/**
 * A stamper for one sender. Called per encoded frame with whether stamping is currently wanted;
 * writes the stamp into frame.data and returns { rung, sequence, sentAt }, or returns null and
 * leaves the frame alone.
 *
 * The H.264 check is per frame as well as per codec decision: before negotiation the decision is
 * provisional, and a frame that does not parse as H.264 must never get an SEI, which would
 * corrupt it. Such a frame consumes no sequence number.
 */
export const createFrameStamper = ({ now = () => Date.now(), onRefused = null } = {}) => {
  const sequences = new Map();
  // SSRC to the small index that goes in the stamp. See rungIndexFor.
  const rungIndices = new Map();
  let refusalReported = false;

  return (frame, wanted) => {
    if (!wanted) return null;
    if (stampInsertionOffset(frame.data) === null) {
      // Said once: an encoder whose layout this does not understand refuses every frame.
      if (!refusalReported && typeof onRefused === 'function') {
        refusalReported = true;
        onRefused(describeFrameLayout(frame.data));
      }
      return null;
    }
    const key = rungKeyOf(metadataOf(frame));
    const rung = rungIndexFor(rungIndices, key);
    const sequence = nextSequenceFor(sequences, key);
    const sentAt = now();
    const stamped = stampFrameBytes(frame.data, { sequence, sentAt, rung });
    if (stamped === null) return null;
    frame.data = stamped;
    return { rung, sequence, sentAt };
  };
};

/**
 * What the player learns from one encoded frame, before it is decoded. Arrival is taken before
 * the frame is parsed, so parsing is never counted as path delay.
 *
 * `arrivedAt` is Date.now, the clock the publisher stamped with. `arrivedAtAbs` is
 * performance.timeOrigin + performance.now(): a worker has its own timeOrigin, so the caller
 * subtracts the page's to put arrival on the timeline requestVideoFrameCallback reports on.
 */
export const readFrame = (frame) => {
  const arrivedAt = Date.now();
  const arrivedAtAbs = performance.timeOrigin + performance.now();
  const stamp = findSeiPayload(frame.data);
  if (stamp === null) return { stamp: null };

  /*
   * The join key: rtpTimestamp is the only field on both getMetadata() and
   * requestVideoFrameCallback's metadata. frame.timestamp is the older spelling of the same
   * value, read as a fallback so such a browser still joins.
   */
  const rtpTimestamp = metadataOf(frame)?.rtpTimestamp ?? frame.timestamp ?? null;
  return { stamp, rtpTimestamp, arrivedAt, arrivedAtAbs };
};
