/*
 * The frame stamp: a sequence number and a send time carried inside the encoded H.264
 * bitstream as an SEI NAL. It lives in the bitstream, not the pixels, because rescaling and
 * simulcast destroy a pixel stamp; an SEI NAL survives them.
 *
 * Pure bytes: no DOM, no WebRTC, no React.
 *
 * SEI is H.264 only: a VP8, VP9 or AV1 frame carries no stamp, and insertStamp refuses a frame
 * that does not parse as H.264, so it cannot write one there. What a transcoding application does
 * with the SEI is not tested here. A decoder and re-encoder would be expected to drop it, which
 * reads as "no stamp"; one that copied it across would carry the source frame's send time on the
 * re-encoded frame. Either way the caller presents a missing stamp as unavailable, never as zero
 * latency.
 */

/*
 * Identifies our SEI among others. Printable ASCII is legible in a hex dump, and every byte is
 * above 0x03, so the marker never triggers emulation prevention.
 */
export const STAMP_UUID = Uint8Array.from(
  'WZFRAMESTAMPv002', (character) => character.charCodeAt(0),
);

const NAL_TYPE_SEI = 6;
const SEI_USER_DATA_UNREGISTERED = 5;
const RBSP_STOP_BYTE = 0x80;

/*
 * Field widths, big endian, fixed. The send time is a Date.now millisecond clock: 6 bytes
 * rather than 4 because it needs 41 bits today, and rather than 8 so it stays within the
 * 53-bit range a JavaScript number represents exactly (no BigInt).
 */
const SEQUENCE_BYTES = 4;
const SENT_AT_BYTES = 6;

/*
 * The rung, added in v002. The sender counts its sequence per rung, and the Engine
 * re-originates every rendition under one SSRC, so the receiver needs the rung to key its
 * baseline: a change of rung starts a new baseline instead of reporting a gap. A small index
 * per sender in order of first appearance, not an SSRC.
 */
const RUNG_BYTES = 1;

const PAYLOAD_BYTES = SEQUENCE_BYTES + SENT_AT_BYTES + RUNG_BYTES;
export const MAX_SEQUENCE = 2 ** (SEQUENCE_BYTES * 8) - 1;
export const MAX_SENT_AT = 2 ** (SENT_AT_BYTES * 8) - 1;
export const MAX_RUNG = 2 ** (RUNG_BYTES * 8) - 1;

/*
 * Arithmetic, not bit shifting: JavaScript bitwise operators truncate to 32 bits, which breaks
 * a 48-bit timestamp.
 */
const writeUint = (bytes, offset, value, width) => {
  let remaining = value;
  for (let index = width - 1; index >= 0; index -= 1) {
    bytes[offset + index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
};

const readUint = (bytes, offset, width) => {
  let value = 0;
  for (let index = 0; index < width; index += 1) value = value * 256 + bytes[offset + index];
  return value;
};

/**
 * Inserts emulation prevention bytes: 0x03 after any two zeros followed by a byte <= 0x03, so
 * the payload never contains a start code. A timestamp can contain 00 00 01 by accident, so
 * skipping this corrupts the stream.
 */
export const addEmulationPrevention = (rbsp) => {
  const escaped = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 0x03) {
      escaped.push(0x03);
      zeros = 0;
    }
    escaped.push(byte);
    zeros = byte === 0x00 ? zeros + 1 : 0;
  }
  return Uint8Array.from(escaped);
};

/** Removes them again. A 0x03 that follows two zeros was inserted by the encoder, not by us. */
export const removeEmulationPrevention = (bytes) => {
  const rbsp = [];
  let zeros = 0;
  for (const byte of bytes) {
    if (zeros >= 2 && byte === 0x03) {
      zeros = 0;
      continue;
    }
    rbsp.push(byte);
    zeros = byte === 0x00 ? zeros + 1 : 0;
  }
  return Uint8Array.from(rbsp);
};

const isWholeNumberInRange = (value, limit) =>
  Number.isInteger(value) && value >= 0 && value <= limit;

/**
 * Builds the complete Annex B SEI NAL that insertStamp places in an encoded frame: start
 * code, NAL header 0x06 (nal_ref_idc 0), payload type 5 (user_data_unregistered), size, UUID,
 * fields, stop byte.
 *
 * Throws on an out-of-range value rather than wrapping it into a plausible wrong number.
 */
export const buildSeiPayload = ({ sequence, sentAt, rung = 0 }) => {
  if (!isWholeNumberInRange(sequence, MAX_SEQUENCE)) {
    throw new RangeError('frame stamp sequence must be a whole number within 32 bits');
  }
  if (!isWholeNumberInRange(sentAt, MAX_SENT_AT)) {
    throw new RangeError('frame stamp sentAt must be a whole number of milliseconds within 48 bits');
  }
  if (!isWholeNumberInRange(rung, MAX_RUNG)) {
    throw new RangeError('frame stamp rung must be a whole number within one byte');
  }

  const payload = new Uint8Array(STAMP_UUID.length + PAYLOAD_BYTES);
  payload.set(STAMP_UUID, 0);
  writeUint(payload, STAMP_UUID.length, sequence, SEQUENCE_BYTES);
  writeUint(payload, STAMP_UUID.length + SEQUENCE_BYTES, sentAt, SENT_AT_BYTES);
  writeUint(payload, STAMP_UUID.length + SEQUENCE_BYTES + SENT_AT_BYTES, rung, RUNG_BYTES);

  // payloadType and payloadSize are 0xff-extended; both of ours are small enough for one byte.
  const rbsp = Uint8Array.from([
    SEI_USER_DATA_UNREGISTERED, payload.length, ...payload, RBSP_STOP_BYTE,
  ]);

  // Escape the whole RBSP: a decoder unescapes before it parses any of it.
  const escaped = addEmulationPrevention(rbsp);
  return Uint8Array.from([0x00, 0x00, 0x00, 0x01, 0x06, ...escaped]);
};

/** Encoded frames arrive as an ArrayBuffer from RTCEncodedVideoFrame.data; take either form. */
const asBytes = (frameBytes) => {
  if (frameBytes instanceof Uint8Array) return frameBytes;
  if (ArrayBuffer.isView(frameBytes)) {
    return new Uint8Array(frameBytes.buffer, frameBytes.byteOffset, frameBytes.byteLength);
  }
  if (frameBytes instanceof ArrayBuffer) return new Uint8Array(frameBytes);
  return null;
};

/** Where the next three-byte start code begins at or after `from`, or -1. */
const nextStartCode = (bytes, from) => {
  for (let index = from; index + 2 < bytes.length; index += 1) {
    if (bytes[index] === 0x00 && bytes[index + 1] === 0x00 && bytes[index + 2] === 0x01) {
      return index;
    }
  }
  return -1;
};

const NAL_TYPE_SLICE = 1;
const NAL_TYPE_IDR = 5;
const NAL_TYPE_SPS = 7;
const NAL_TYPE_PPS = 8;
const NAL_TYPE_AUD = 9;
const NAL_TYPE_END_OF_SEQUENCE = 10;
const NAL_TYPE_END_OF_STREAM = 11;
const NAL_TYPE_FILLER = 12;
const NAL_TYPE_PREFIX = 14;

/* Types 1 to 5 carry picture data. Everything that belongs to a picture comes before the first. */
const isVclType = (type) => type >= 1 && type <= 5;

/**
 * Walks the NAL units of an Annex B frame lazily, calling `visit(nal)` with
 * { header, type, codeAt, start, end } until it returns true or the frame ends. `codeAt` is where
 * the NAL's start code begins, including the zero_byte of a four-byte one. `end` excludes the
 * trailing zeros that belong to the next start code. Only the bytes up to the NAL the visitor
 * stops at are scanned, so a caller that stops at the first slice never reads the slice data.
 */
const walkNalUnits = (bytes, visit) => {
  let code = nextStartCode(bytes, 0);
  while (code !== -1) {
    const start = code + 3;
    if (start >= bytes.length) return;
    const header = bytes[start];
    const codeAt = code > 0 && bytes[code - 1] === 0x00 ? code - 1 : code;
    const type = header & 0x1f;

    // The end of a slice is never needed, so its bytes are never scanned.
    const next = isVclType(type) ? -1 : nextStartCode(bytes, start);
    let end = next === -1 ? bytes.length : next;
    while (end > start && bytes[end - 1] === 0x00) end -= 1;

    if (visit({ header, type, codeAt, start, end }) === true) return;
    if (next === -1) return;
    code = next;
  }
};

/*
 * The NAL headers an H.264 encoder puts ahead of the first slice, and the slices themselves,
 * each with the nal_ref_idc the standard allows it. Anything else, including every NAL header of
 * an HEVC keyframe or delta frame read as H.264, means "not a frame this module understands".
 */
const isPlausibleH264Header = (header) => {
  if ((header & 0x80) !== 0) return false; // forbidden_zero_bit
  const referenced = (header & 0x60) !== 0;
  switch (header & 0x1f) {
    case NAL_TYPE_SEI:
    case NAL_TYPE_AUD:
    case NAL_TYPE_END_OF_SEQUENCE:
    case NAL_TYPE_END_OF_STREAM:
    case NAL_TYPE_FILLER: // hardware encoders pad to a constant bitrate with it
      return !referenced;
    case NAL_TYPE_SPS:
    case NAL_TYPE_PPS:
    case NAL_TYPE_IDR:
      return referenced;
    case NAL_TYPE_SLICE:
    case NAL_TYPE_PREFIX: // carries its slice's nal_ref_idc, so any value
      return true;
    default:
      return false;
  }
};

/**
 * Where the stamp goes in an encoded frame: immediately in front of the first slice, which is
 * after any access unit delimiter, parameter sets and existing SEI. H.264 requires the delimiter
 * to come first and every SEI to come before the first slice (7.4.1.2.3), and keeping existing
 * SEI ahead of ours keeps a buffering period SEI first. Returns the byte offset, or null when the
 * frame does not start with a start code, carries a NAL header H.264 does not allow here, or has
 * no slice at all: VP8, VP9 and AV1 frames have no start code, and an HEVC frame fails the header
 * check, so none of them can be stamped by mistake.
 */
export const stampInsertionOffset = (frameBytes) => {
  const bytes = asBytes(frameBytes);
  if (bytes === null || bytes.length < 4) return null;
  const first = nextStartCode(bytes, 0);
  // Annex B allows any number of zero bytes ahead of the first start code, and nothing else.
  if (first === -1 || !bytes.subarray(0, first).every((b) => b === 0x00)) return null;

  /*
   * A prefix NAL (type 14) belongs to the slice straight after it, so the stamp goes in front
   * of the prefix, never between the two. Hardware encoders that emit temporal layers write
   * one ahead of every slice. Anything but a slice after a prefix is not H.264 we understand.
   */
  let offset = null;
  let plausible = true;
  let prefixAt = null;
  walkNalUnits(bytes, (nal) => {
    if (!isPlausibleH264Header(nal.header)) {
      plausible = false;
      return true;
    }
    if (isVclType(nal.type)) {
      offset = prefixAt ?? nal.codeAt;
      return true;
    }
    if (prefixAt !== null) {
      plausible = false;
      return true;
    }
    if (nal.type === NAL_TYPE_PREFIX) prefixAt = nal.codeAt;
    return false;
  });
  return plausible ? offset : null;
};

/**
 * A short account of how a frame is laid out, for the log line that says why a frame could not
 * be stamped: the bytes ahead of the first start code, then each NAL up to the first slice as
 * type/nal_ref_idc. For example "lead 00 00 00 01, NAL 9/0 7/3 8/3 5/3".
 */
export const describeFrameLayout = (frameBytes) => {
  const bytes = asBytes(frameBytes);
  if (bytes === null) return 'not bytes';
  const lead = Array.from(bytes.subarray(0, 6), (b) => b.toString(16).padStart(2, '0')).join(' ');
  const nals = [];
  walkNalUnits(bytes, ({ header, type }) => {
    nals.push(`${type}/${(header >> 5) & 0x03}${(header & 0x80) !== 0 ? '!' : ''}`);
    return isVclType(type) || nals.length >= 12;
  });
  return `${bytes.length} bytes, lead ${lead}, NAL ${nals.length ? nals.join(' ') : 'none'}`;
};

/**
 * The encoded frame with the stamp inserted in front of its first slice, as a fresh Uint8Array,
 * or null when the frame is not H.264 this module can place a stamp in (see
 * stampInsertionOffset). The existing NALs are copied unchanged. A caller given null sends the
 * frame untouched.
 */
export const insertStamp = (frameBytes, stamp) => {
  const bytes = asBytes(frameBytes);
  const offset = stampInsertionOffset(bytes);
  if (offset === null) return null;

  const sei = buildSeiPayload(stamp);
  const stamped = new Uint8Array(bytes.length + sei.length);
  stamped.set(bytes.subarray(0, offset), 0);
  stamped.set(sei, offset);
  stamped.set(bytes.subarray(offset), offset + sei.length);
  return stamped;
};

/*
 * more_rbsp_data, byte aligned: only the stop byte left (ignoring padding zeros) means the end.
 * "Next byte is 0x80" alone is not safe, because payload type 128 also encodes as 0x80.
 */
const hasMoreSeiMessages = (rbsp, offset) => {
  let end = rbsp.length;
  while (end > offset && rbsp[end - 1] === 0x00) end -= 1;
  if (end <= offset) return false;
  return !(end - offset === 1 && rbsp[offset] === RBSP_STOP_BYTE);
};

/** 0xff-extended value: any number of 0xff bytes, each worth 255, then the remainder. */
const readExtendedValue = (rbsp, offset) => {
  let value = 0;
  let index = offset;
  while (index < rbsp.length && rbsp[index] === 0xff) {
    value += 255;
    index += 1;
  }
  if (index >= rbsp.length) return null;
  value += rbsp[index];
  return { value, next: index + 1 };
};

const startsWithStampUuid = (payload) => {
  if (payload.length !== STAMP_UUID.length + PAYLOAD_BYTES) return false;
  for (let index = 0; index < STAMP_UUID.length; index += 1) {
    if (payload[index] !== STAMP_UUID[index]) return false;
  }
  return true;
};

/** Walks the SEI messages in one unescaped SEI NAL, returning ours if it is among them. */
const readStampFromSeiRbsp = (rbsp) => {
  let offset = 0;
  while (hasMoreSeiMessages(rbsp, offset)) {
    const type = readExtendedValue(rbsp, offset);
    if (type === null) return null;
    const size = readExtendedValue(rbsp, type.next);
    if (size === null) return null;

    const end = size.next + size.value;
    // A size past the end of the NAL means this is not the structure we expect.
    if (end > rbsp.length) return null;

    const payload = rbsp.subarray(size.next, end);
    if (type.value === SEI_USER_DATA_UNREGISTERED && startsWithStampUuid(payload)) {
      return {
        sequence: readUint(payload, STAMP_UUID.length, SEQUENCE_BYTES),
        sentAt: readUint(payload, STAMP_UUID.length + SEQUENCE_BYTES, SENT_AT_BYTES),
        rung: readUint(payload, STAMP_UUID.length + SEQUENCE_BYTES + SENT_AT_BYTES, RUNG_BYTES),
      };
    }
    offset = end;
  }
  return null;
};

/**
 * Finds our stamp in an encoded frame, or returns null for anything that does not carry one.
 * The caller reports null as "no frame stamp", never as zero latency.
 *
 * The marker is not assumed to be the first NAL: a keyframe carries SPS and PPS first, and
 * nothing guarantees position after the Engine. The search stops at the first slice, because an
 * SEI after it would belong to the next picture, and because the slice data is almost all of the
 * frame and holds nothing to find.
 */
export const findSeiPayload = (frameBytes) => {
  const bytes = asBytes(frameBytes);
  if (bytes === null || bytes.length === 0) return null;

  let stamp = null;
  walkNalUnits(bytes, ({ header, type, start, end }) => {
    // Bit 7 is forbidden_zero_bit: set means this is not a NAL header we understand.
    if ((header & 0x80) !== 0) return false;
    if (isVclType(type)) return true;
    if (type !== NAL_TYPE_SEI || end - start < 2) return false;
    stamp = readStampFromSeiRbsp(removeEmulationPrevention(bytes.subarray(start + 1, end)));
    return stamp !== null;
  });
  return stamp;
};
