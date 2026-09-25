/*
 * The latency probe: how long a frame takes from the publisher's encoder to the player's
 * screen, split at the point where this browser reads the frame off the wire.
 *
 * Every encoded frame carries a sequence number and send time as an H.264 SEI NAL (see
 * utils/frameStamp.js), read on the receiver before decode and joined to the presented frame
 * by rtpTimestamp:
 *
 *   encode ->| SEI written |-> pace, network, Engine, network -> assemble |<- SEI read ->|
 *                  t0                                                          t1
 *        -> frame buffer (jitter buffer wait) -> decode -> display
 *                                                             t2
 *
 *   t1 - t0   transport: publisher pacing and packetizing, both network legs, the Engine, and
 *             the wait for the frame's packets to arrive (retransmissions included)
 *   t2 - t1   player: the jitter buffer wait, decode, compositor, wait until scheduled for display
 *   t2 - t0   end to end, minus capture and encode
 *
 * Where t1 falls was read from libwebrtc (video/rtp_video_stream_receiver2.cc): the receive-side
 * frame transformer runs in OnAssembledFrame, once the packet buffer has a whole frame, and hands
 * the frame on to the reference finder and then VideoReceiveStream2::OnCompleteFrame, which
 * inserts it into VideoStreamBufferController, the frame buffer that holds it until its render
 * time. So the jitter buffer wait is in the player leg, not the transport leg. On the sender the
 * transform runs before packetization, so pacing is in the transport leg.
 *
 * Not included: sensor and ISP delay, the encoder queue, and panel emission. expectedDisplayTime
 * is a prediction, not an observation.
 *
 * The transforms run in a worker: the encoded streams from createEncodedStreams are transferred
 * to latencyProbeWorker.js, which takes t0 and t1, so a busy page cannot move time from one leg
 * to the other. Where a worker cannot start or the streams cannot be transferred, they run on the
 * main thread instead, and the log says so. There, a busy player page delays the moment t1 is
 * read, which moves that delay from the player leg into the transport leg (the total is
 * unaffected), and a busy publisher page delays t0, which hides the delay from both.
 *
 * Structure: everything above the "browser plumbing" line is pure and unit tested. Below it are
 * the two encoded-stream transforms, the video-frame callback and the clock data channel.
 *
 * Chromium only (createEncodedStreams). Without it the probe reports unavailable with a reason.
 */

import { MAX_SEQUENCE } from '../utils/frameStamp';
import attachDataChannel from '../webrtc/attachDataChannel';
import {
  CLOCK_GRANULARITY_MS,
  MAX_TRUSTED_UNCERTAINTY_MS,
  MIN_SAMPLES,
  TIMER_RESOLUTION_MS,
  WINDOW_SAMPLES,
  countUsableSamples,
  estimateOffset,
} from './clockSync';
import {
  createFrameStamper,
  nextSequenceFor,
  readFrame,
  rungIndexFor,
  stampFrameBytes,
} from './frameTransforms';
import { logEvent } from './signalLog';

// Pure per-frame helpers, kept importable from here for the tests and older callers.
export { nextSequenceFor, rungIndexFor, stampFrameBytes };

// Its own channel, not chat: the exchange runs all session and must work with chat switched off.
export const CLOCK_CHANNEL_LABEL = 'wz-clock';

// The sequence space the stamp's 32-bit field can carry, used for wrap-safe gap counting.
const SEQUENCE_SPACE = MAX_SEQUENCE + 1;

/*
 * Frames the medians cover: 2 to 4 s at 30 to 60 fps. It must also outlast the join, since
 * requestVideoFrameCallback reports a frame only after it is decoded and scheduled.
 */
export const FRAME_WINDOW = 120;

// No stamped frame for this long means the stream stopped. Kept short so a stall shows as
// stale rather than as a frozen figure. The panel reads the status this produces, so there is
// one threshold, not two.
export const STALE_MS = 1000;

/* ------------------------------------------------------------------ pure logic ------------- */

/**
 * Whether to write the stamp into this sender's frames.
 *
 * SEI is H.264 only: prepended to a VP8, VP9 or AV1 frame it corrupts the frame, so an unknown
 * codec means do not stamp. `mimeType` is the negotiated codec. `wanted` is the page setting,
 * used only until negotiation, so a decision from it comes back unresolved.
 */
export const decideStamping = (mimeType, wanted) => {
  const isH264 = (value) => typeof value === 'string' && /h\.?264|avc/i.test(value);

  if (isH264(mimeType)) return { stamp: true, resolved: true, reason: null };
  if (typeof mimeType === 'string' && mimeType !== '') {
    return {
      stamp: false,
      resolved: true,
      reason: `The frame stamp is an H.264 SEI NAL and this sender negotiated ${mimeType}.`,
    };
  }
  if (isH264(wanted)) return { stamp: true, resolved: false, reason: null };
  return {
    stamp: false,
    resolved: false,
    reason: 'Waiting for the negotiated video codec before stamping.',
  };
};

/**
 * Frames lost between two received sequence numbers. Reordering and duplicates count as zero,
 * and the modulo keeps the count right across the 32-bit wrap.
 */
export const countMissedFrames = (previous, sequence) => {
  if (!Number.isInteger(previous) || !Number.isInteger(sequence)) return 0;
  const gap = (sequence - previous + SEQUENCE_SPACE) % SEQUENCE_SPACE;
  // Half the space forward or more is a wrap seen backwards: reordering, not lost frames.
  if (gap === 0 || gap >= SEQUENCE_SPACE / 2) return 0;
  return gap - 1;
};

/**
 * The middle observed value, not the mean, because per-frame latency is long tailed. On an even
 * count it returns the lower middle, so every figure is one some frame actually had.
 */
export const median = (values) => {
  const usable = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (usable.length === 0) return null;
  const sorted = [...usable].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};

/**
 * What the clock exchange currently supports. Zero never stands in for "unknown": state 'ok'
 * with offsetMs 0 is a measurement, state 'unknown' is a refusal.
 *
 * `sameContext` is a proven topology, not a guess: the caller sets it only when every frame in
 * the window is one this page stamped itself (see isOwnFrame). Both timestamps then come from
 * one Date.now in one JavaScript context, so the offset is exactly zero whatever the clock
 * exchange estimates, and the only error left is the resolution of Date.now.
 */
export const describeClock = (samples, { sameContext = false } = {}) => {
  const usable = countUsableSamples(samples);

  if (sameContext) {
    return {
      state: 'ok',
      offsetMs: 0,
      uncertaintyMs: TIMER_RESOLUTION_MS,
      samples: usable,
      mode: 'same-context',
      exact: true,
      warming: false,
      reason: null,
    };
  }

  const estimate = estimateOffset(samples);

  if (estimate === null) {
    // Too few usable samples is the normal first few seconds, not a failure.
    const warming = usable < MIN_SAMPLES;
    return {
      state: 'unknown',
      offsetMs: null,
      uncertaintyMs: null,
      samples: usable,
      mode: null,
      exact: false,
      warming,
      reason: warming
        ? `Exchanging clock samples (${usable} of ${MIN_SAMPLES}).`
        : 'The clock offset is not stable enough to measure.',
    };
  }

  if (estimate.uncertaintyMs > MAX_TRUSTED_UNCERTAINTY_MS) {
    return {
      state: 'untrusted',
      offsetMs: estimate.offsetMs,
      uncertaintyMs: estimate.uncertaintyMs,
      samples: estimate.samples,
      mode: null,
      exact: false,
      warming: false,
      reason: `Clock offset too uncertain to measure (± ${Math.round(estimate.uncertaintyMs)} ms).`,
    };
  }

  /*
   * Processes on one machine share the OS clock, so offset and bound collapse to its resolution
   * and "exact" reads better than "0 ms plus or minus 1 ms". This makes no claim about where the
   * far end runs: a near-zero offset with a tiny bound says only that the two clocks agree, and
   * it needs a round trip of about 2 ms, so in practice a local Engine.
   */
  const sameClock = Math.abs(estimate.offsetMs) <= CLOCK_GRANULARITY_MS
    && estimate.uncertaintyMs <= CLOCK_GRANULARITY_MS;

  return {
    state: 'ok',
    offsetMs: estimate.offsetMs,
    uncertaintyMs: estimate.uncertaintyMs,
    samples: estimate.samples,
    mode: sameClock ? 'same-clock' : 'cross-machine',
    exact: sameClock,
    warming: false,
    reason: null,
  };
};

/*
 * How many of this page's own stamps are remembered for the proof above: about 11 s of a
 * three-rung 30 fps publish, far longer than any frame takes to come back through the Engine.
 */
export const SENT_MEMORY = 1024;

const sentKey = ({ rung, sequence }) => `${rung}:${sequence}`;

/**
 * Whether a received stamp is one this page wrote: the same rung and sequence with the same
 * millisecond send time. A different publisher matching all three by accident would need its
 * clock and sequence counter to agree with ours to the millisecond on every frame in the window.
 */
export const isOwnFrame = (sentStamps, stamp) =>
  sentStamps instanceof Map && stamp != null
  && sentStamps.get(sentKey(stamp)) === stamp.sentAt;

/** Records a stamp this page wrote. `sentStamps` is mutated and kept to SENT_MEMORY entries. */
export const recordSentStamp = (sentStamps, stamp) => {
  const key = sentKey(stamp);
  sentStamps.delete(key);
  sentStamps.set(key, stamp.sentAt);
  while (sentStamps.size > SENT_MEMORY) sentStamps.delete(sentStamps.keys().next().value);
};

/**
 * The three figures for one received frame, or nulls where a figure cannot be had.
 *
 * `sentAt` is on the publisher's clock, so transport needs the offset (farTime - offsetMs is
 * local). The player leg subtracts two local monotonic readings and is reported without one. A
 * negative transport figure is returned as measured: it is the evidence of a wrong clock estimate.
 */
export const frameLatency = (record, offsetMs) => {
  const transportMs = typeof offsetMs === 'number'
    ? record.arrivedAt - (record.sentAt - offsetMs)
    : null;
  const playerMs = typeof record.displayAtHighRes === 'number'
    ? record.displayAtHighRes - record.arrivedAtHighRes
    : null;
  return {
    transportMs,
    playerMs,
    totalMs: transportMs === null || playerMs === null ? null : transportMs + playerMs,
  };
};

/**
 * The three medians, taken over one set of frames so the rows describe the same frames: the
 * frames with both legs when there are any, and otherwise whichever leg exists (the transport
 * leg before the display join has caught up, the player leg while the clock is unknown), with
 * the total left null because nothing can be added up. A median of sums is not the sum of the
 * medians, so Total can still differ from the two legs added by a millisecond or two.
 */
export const mediansOverOneFrameSet = (perFrame) => {
  const joined = perFrame.filter((frame) => frame.totalMs !== null);
  if (joined.length > 0) {
    return {
      transportMs: median(joined.map((frame) => frame.transportMs)),
      playerMs: median(joined.map((frame) => frame.playerMs)),
      totalMs: median(joined.map((frame) => frame.totalMs)),
      figureFrames: joined.length,
    };
  }
  const transport = perFrame.map((frame) => frame.transportMs).filter((value) => value !== null);
  const player = perFrame.map((frame) => frame.playerMs).filter((value) => value !== null);
  return {
    transportMs: median(transport),
    playerMs: median(player),
    totalMs: null,
    figureFrames: Math.max(transport.length, player.length),
  };
};

/**
 * Turns the probe's state into the object the UI subscribes to. Pure, with `now` a parameter.
 *
 *   off        nothing is running on this page
 *   waiting    the receiver is attached but no video frame has arrived yet
 *   no-stamp   frames are arriving and none carry a stamp
 *   stalled    stamped frames arrived and then stopped
 *   measuring  there is a figure
 */
export const summarizeProbe = (state, now) => {
  // Proven, not inferred: every frame in the window is one this page stamped.
  const sameContext = state.frames.length > 0
    && state.frames.every((record) => record.own === true);
  const clock = describeClock(state.clockSamples, { sameContext });
  const base = {
    transportMs: null,
    playerMs: null,
    totalMs: null,
    figureFrames: 0,
    missedFrames: state.missedFrames,
    lastSequence: state.lastSequence,
    stampedFrames: state.stampedFrames,
    unstampedFrames: state.unstampedFrames,
    joinedFrames: state.joinedFrames,
    lastFrameAt: state.lastFrameAt,
    frameWindow: state.frames.length,
    clock,
    sender: {
      status: state.senderStatus,
      reason: state.senderReason,
      stampedFrames: state.stampedOut,
    },
  };

  if (state.receiverStatus === 'off') {
    return { ...base, status: 'off', reason: state.receiverReason };
  }
  if (state.stampedFrames === 0 && state.unstampedFrames === 0) {
    return { ...base, status: 'waiting', reason: 'No video frames received yet.' };
  }
  if (state.stampedFrames === 0) {
    return {
      ...base,
      status: 'no-stamp',
      // Name the likely causes, or a transcoding application reads as a broken feature.
      reason: 'No frame stamp in this stream. The publisher has the probe off, the codec is not '
        + 'H.264, or something between the two re-encoded the video (a transcoding application, '
        + 'for example).',
    };
  }

  const offsetMs = clock.state === 'ok' ? clock.offsetMs : null;
  const figures = mediansOverOneFrameSet(
    state.frames.map((record) => frameLatency(record, offsetMs)),
  );

  // A stall keeps the last real figures, marked stalled, so the panel can gray them out.
  if (now - state.lastFrameAt > STALE_MS) {
    return {
      ...base,
      ...figures,
      status: 'stalled',
      reason: `No stamped frame for ${Math.round((now - state.lastFrameAt) / 100) / 10} s.`,
    };
  }

  return {
    ...base,
    ...figures,
    status: 'measuring',
    // A trusted clock is what the transport leg needs; the player leg never needed one.
    reason: clock.state === 'ok' ? null : clock.reason,
  };
};

/* --------------------------------------------------------------- clock protocol ------------- */

// Tagged, because the label is no guarantee. Anything on the channel that is not ours is ignored.
const CLOCK_MESSAGE_TAG = 'wz-clock';
const CLOCK_MESSAGE_VERSION = 1;

/*
 * Who asked. The Engine mirrors the publisher's replies to every viewer, and sequences start at
 * zero on each player, so without an id two viewers take each other's replies and estimate the
 * offset from another machine's clock. Random, because no counter is shared between ends.
 */
export const newClockSessionId = () => Math.floor(Math.random() * 0xffffffff);

export const buildClockPing = ({ sequence, t0, id }) =>
  JSON.stringify({ wz: CLOCK_MESSAGE_TAG, v: CLOCK_MESSAGE_VERSION, seq: sequence, t0, id });

export const buildClockReply = ({ ping, t1, t2 }) =>
  JSON.stringify({
    wz: CLOCK_MESSAGE_TAG, v: CLOCK_MESSAGE_VERSION,
    seq: ping.sequence, t0: ping.t0, id: ping.id, t1, t2,
  });

/**
 * Reads one clock message, or returns null for anything that is not one. `kind` separates ping
 * from reply, so a page running both arms (the split view) never answers its own reply.
 */
export const parseClockMessage = (data) => {
  if (typeof data !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || parsed.wz !== CLOCK_MESSAGE_TAG || parsed.v !== CLOCK_MESSAGE_VERSION) return null;

  const numeric = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const sequence = numeric(parsed.seq);
  const t0 = numeric(parsed.t0);
  if (sequence === null || t0 === null) return null;

  // Null for a message without an id, which every check treats as "not mine".
  const id = numeric(parsed.id);

  const t1 = numeric(parsed.t1);
  const t2 = numeric(parsed.t2);
  if (t1 === null || t2 === null) return { kind: 'ping', sequence, t0, id };
  return { kind: 'reply', sequence, t0, t1, t2, id };
};

/* ------------------------------------------------------- availability and the store --------- */

/**
 * Why the probe cannot run here, or null when it can. Checked at call time, not import, so the
 * module still loads in a test environment with no RTCRtpSender.
 */
export const probeUnavailableReason = () => {
  const has = (constructor) => typeof constructor === 'function'
    && typeof constructor.prototype?.createEncodedStreams === 'function';

  if (typeof window === 'undefined') return 'The latency probe needs a browser.';
  if (!has(window.RTCRtpSender) || !has(window.RTCRtpReceiver)) {
    return 'Needs insertable streams (createEncodedStreams), which today means a Chromium '
      + 'browser: Chrome, Edge or Brave. This build does not use the RTCRtpScriptTransform '
      + 'route that other browsers offer.';
  }
  return null;
};

export const isProbeAvailable = () => probeUnavailableReason() === null;

/**
 * The same answer, shaped for the settings toggle and the readout. Kept here rather than in
 * LatencyGroup.jsx so that file exports only components and Fast Refresh keeps working.
 */
export const latencyProbeSupport = () => {
  const reason = probeUnavailableReason();
  return { supported: reason === null, reason };
};

/**
 * Adds the peer-connection flag the transforms need. encodedInsertableStreams can only be set
 * when the RTCPeerConnection is constructed, so the two start paths call this beforehand.
 * Returns whether the flag was set.
 */
export const configureEncodedStreams = (config, enabled) => {
  if (!config || !enabled || !isProbeAvailable()) return false;
  config.encodedInsertableStreams = true;
  return true;
};

const createState = () => ({
  senderStatus: 'off', // off | stamping | refused
  senderReason: null,
  stampedOut: 0,
  receiverStatus: 'off', // off | reading
  receiverReason: null,
  receiver: null, // the RTCRtpReceiver already attached, so a repeat attach is recognized

  frames: [],
  byRtpTimestamp: new Map(),
  stampedFrames: 0,
  unstampedFrames: 0,
  missedFrames: 0,
  lastSequence: null,
  lastRung: null,
  lastFrameAt: null,
  joinedFrames: 0,
  clockSamples: [],
  // This page's own stamps, for the same-context proof. See isOwnFrame.
  sentStamps: new Map(),
  // Presented frames whose encoded record has not arrived yet. See holdDisplay.
  pendingDisplay: new Map(),
});

let state = createState();
let sample = summarizeProbe(state, Date.now());
const listeners = new Set();
let emitTimer = null;

// Emitted on a timer, not per frame, so a 60 fps stream does not mean 60 React renders a second.
export const EMIT_INTERVAL_MS = 500;

/*
 * Nothing measured yet publishes null, not a sample of nulls, so a subscriber can tell silence
 * from a figure. After the first stamped frame every tick publishes, including the ticks after
 * the stream stops, so the subscriber sees the 'stalled' status rather than having to guess
 * a stall from the age of the last sample.
 */
const emit = ({ force = false } = {}) => {
  sample = summarizeProbe(state, Date.now());

  if (state.stampedFrames === 0) {
    if (force) for (const fn of listeners) fn(null);
    return;
  }
  for (const fn of listeners) fn(sample);
};

const startEmitting = () => {
  if (emitTimer !== null) return;
  emitTimer = setInterval(emit, EMIT_INTERVAL_MS);
  emit({ force: true });
};

const stopEmitting = () => {
  if (emitTimer === null) return;
  clearInterval(emitTimer);
  emitTimer = null;
  emit({ force: true });
};

/**
 * Pub/sub as signalLog does it: the current value at once, and an unsubscribe back. The value
 * is null until a stamped frame has been read.
 */
export const subscribe = (fn) => {
  listeners.add(fn);
  fn(state.stampedFrames === 0 ? null : sample);
  return () => listeners.delete(fn);
};

/** The full state, never null, for a caller that wants the status and reason behind no figure. */
export const getSample = () => sample;

/*
 * Clears what was measured, and nothing else. Called when a receiver starts, so figures from a
 * previous session never leak into a new one. Sender state is left alone: on the split view the
 * publisher is already stamping when the player starts.
 */
const resetMeasurements = () => {
  state.frames = [];
  state.byRtpTimestamp = new Map();
  state.pendingDisplay = new Map();
  state.stampedFrames = 0;
  state.unstampedFrames = 0;
  state.missedFrames = 0;
  state.lastSequence = null;
  state.lastRung = null;
  state.lastFrameAt = null;
  state.joinedFrames = 0;
  state.clockSamples = [];
};

/** Back to nothing running and nothing measured. */
export const resetProbe = () => {
  state = createState();
  emit({ force: true });
};

/* ---------------------------------------------------------------- browser plumbing ---------- */

/*
 * createEncodedStreams can be called once per sender or receiver and has no detach, so a
 * transform lives as long as the peer connection and stop() turns it into a pass-through. The
 * UI toggle therefore takes effect on the next connect.
 *
 * The probed video's transform runs in a worker (latencyProbeWorker.js) when the browser can
 * start one and transfer the encoded streams to it, so a busy page does not move time from one
 * leg to the other. Otherwise it runs here, on the main thread, and says so in the log.
 */

/** Said once per stream, because a broken transform would otherwise say it 60 times a second. */
const reportTransformFailure = (label, error, once) => {
  if (once.reported) return;
  once.reported = true;
  logEvent('error', 'pc', `latency probe ${label} failed; frames pass through untouched`,
    error?.message ?? String(error));
};

// How long a worker gets to load before the transform falls back to the main thread.
const WORKER_START_MS = 2000;

/*
 * The streams are created at once, because a receiver's can only be taken in the track event,
 * and frames queue in them until something reads. They are handed over only after the worker
 * says it is running: a worker that fails to load would otherwise hold the media forever.
 */
const startWorker = () => {
  if (typeof Worker !== 'function') return null;
  try {
    return new Worker(new URL('./latencyProbeWorker.js', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
};

/*
 * Pipes the encoded stream through the transform, or reports why it could not. It runs inside
 * the publish and play paths and createEncodedStreams throws if already called or if the
 * connection lacks encodedInsertableStreams, so nothing may escape: a diagnostic must not break
 * publishing.
 *
 * `mainThread()` builds the TransformStream for the main-thread route. `worker`, when given, is
 * { op, initial(), onMessage(data) } for the worker route. Returns { attached, reason, post },
 * where post sends a message to the worker if one took the streams.
 */
const pipeEncodedStream = (endpoint, { label, mainThread, worker: route = null, isStopped }) => {
  const failure = { reported: false };
  let streams;
  try {
    streams = endpoint.createEncodedStreams();
  } catch (error) {
    const reason = `Could not read the ${label}'s encoded frames: ${error?.message ?? String(error)}`;
    logEvent('error', 'pc', 'latency probe could not attach', reason);
    return { attached: false, reason, post: () => {} };
  }

  const onMainThread = () => {
    streams.readable.pipeThrough(mainThread()).pipeTo(streams.writable).catch((error) => {
      // Expected when the connection closes; only worth a line when it happens mid-session.
      if (!isStopped()) reportTransformFailure(`${label} stream`, error, failure);
    });
  };

  const handle = { attached: true, reason: null, post: () => {} };
  const worker = route ? startWorker() : null;
  if (worker === null) {
    onMainThread();
    return handle;
  }

  let settled = false;
  let timer = null;
  const fallBack = (why) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    worker.terminate();
    logEvent('info', 'pc', `latency probe ${label} transform runs on the main thread`, why);
    onMainThread();
  };
  timer = window.setTimeout(() => fallBack('The worker did not start in time.'), WORKER_START_MS);

  worker.onerror = (event) => {
    event.preventDefault?.();
    if (!settled) fallBack(event.message || 'The worker failed to load.');
    else reportTransformFailure(`${label} worker`, event.message || 'worker error', failure);
  };

  worker.onmessage = ({ data }) => {
    if (!data) return;
    if (data.op === 'ready') {
      if (settled) return;
      try {
        worker.postMessage(
          { op: route.op, readable: streams.readable, writable: streams.writable, ...route.initial() },
          [streams.readable, streams.writable],
        );
      } catch (error) {
        // Not transferable in this browser: the streams are still ours to pipe here.
        fallBack(error?.message ?? String(error));
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      handle.post = (message) => worker.postMessage(message);
      return;
    }
    if (data.op === 'ended') {
      worker.terminate();
      if (data.message && !isStopped()) reportTransformFailure(`${label} stream`, data.message, failure);
      return;
    }
    if (data.op === 'error') {
      reportTransformFailure(label, data.message, failure);
      return;
    }
    route.onMessage(data);
  };

  return handle;
};

/**
 * Keeps an encoded stream flowing, unchanged, that nothing wants to look at.
 *
 * encodedInsertableStreams applies to the whole peer connection, and an endpoint whose frames
 * nobody reads sends nothing (with the probe on, audio went out silent). So every endpoint
 * other than the probed video gets this pass-through. It does no work per frame, so it stays on
 * the main thread.
 */
export const passThroughEncodedFrames = (endpoint, label) => {
  if (!endpoint || typeof endpoint.createEncodedStreams !== 'function') return { stop: () => {} };

  let stopped = false;
  pipeEncodedStream(endpoint, {
    label,
    mainThread: () => new TransformStream({
      transform(frame, controller) { controller.enqueue(frame); },
    }),
    isStopped: () => stopped,
  });
  return { stop: () => { stopped = true; } };
};

// How often a provisional codec decision is taken again, until the negotiated codec is known.
const DECISION_POLL_MS = 250;

/**
 * Publisher: write the stamp into every encoded video frame. `videoCodec` is the page's codec
 * setting, used only until the negotiated parameters are readable. Returns { stop }.
 */
export const startSenderStamp = (videoSender, { videoCodec } = {}) => {
  const unavailable = probeUnavailableReason();
  if (unavailable || !videoSender || typeof videoSender.createEncodedStreams !== 'function') {
    state.senderStatus = 'refused';
    state.senderReason = unavailable
      || 'No video sender to stamp, so this publish carries no frame stamp.';
    logEvent('error', 'pc', 'latency probe not stamping', state.senderReason);
    emit();
    return { stop: () => {} };
  }

  let stopped = false;
  let decision = decideStamping(null, videoCodec);
  let pollTimer = null;
  state.sentStamps = new Map();
  const failure = { reported: false };

  const onSent = (stamp) => {
    if (stopped) return;
    recordSentStamp(state.sentStamps, stamp);
    state.stampedOut += 1;
  };

  const senderCodec = () => {
    try {
      const codecs = videoSender.getParameters()?.codecs;
      return Array.isArray(codecs) && codecs.length > 0 ? codecs[0].mimeType : null;
    } catch {
      // getParameters throws before the sender is negotiated, which is the unresolved case.
      return null;
    }
  };

  const stamper = createFrameStamper();
  const attached = pipeEncodedStream(videoSender, {
    label: 'sender',
    mainThread: () => new TransformStream({
      transform(frame, controller) {
        try {
          if (!stopped) {
            const sent = stamper(frame, decision.stamp);
            if (sent) onSent(sent);
          }
        } catch (error) {
          reportTransformFailure('sender', error, failure);
        }
        // The frame goes on in every case, stamped or not. A diagnostic must not drop media.
        controller.enqueue(frame);
      },
    }),
    worker: {
      op: 'sender',
      initial: () => ({ stamp: !stopped && decision.stamp }),
      onMessage: (data) => { if (data.op === 'sent') onSent(data); },
    },
    isStopped: () => stopped,
  });

  // The codec is re-read only while the answer is still provisional.
  const poll = () => {
    pollTimer = null;
    if (stopped || decision.resolved) return;
    const next = decideStamping(senderCodec(), videoCodec);
    if (next.resolved || next.stamp !== decision.stamp) {
      decision = next;
      attached.post({ op: 'stamp', stamp: next.stamp });
      state.senderStatus = next.stamp ? 'stamping' : 'refused';
      state.senderReason = next.reason;
      logEvent(next.stamp ? 'info' : 'error', 'pc',
        next.stamp ? 'latency probe stamping frames' : 'latency probe not stamping',
        next.reason);
    }
    if (!decision.resolved) pollTimer = window.setTimeout(poll, DECISION_POLL_MS);
  };

  state.stampedOut = 0;
  if (attached.attached) {
    state.senderStatus = decision.stamp ? 'stamping' : 'refused';
    state.senderReason = decision.reason;
    poll();
  } else {
    state.senderStatus = 'refused';
    state.senderReason = attached.reason;
  }
  emit();

  return {
    stop: () => {
      stopped = true;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      attached.post({ op: 'stop' });
      state.senderStatus = 'off';
      state.senderReason = null;
      emit();
    },
  };
};

/*
 * A presented frame whose encoded record has not arrived yet: possible when the record comes
 * from a worker, whose message can land after the frame is shown. Held until the record comes.
 */
const holdDisplay = (rtpTimestamp, expectedDisplayTime) => {
  state.pendingDisplay.set(rtpTimestamp, expectedDisplayTime);
  while (state.pendingDisplay.size > FRAME_WINDOW) {
    state.pendingDisplay.delete(state.pendingDisplay.keys().next().value);
  }
};

/** Drops the oldest record once the window is full, keeping the join map in step with it. */
const remember = (record) => {
  const shown = state.pendingDisplay.get(record.rtpTimestamp);
  if (shown !== undefined && record.displayAtHighRes === null) {
    state.pendingDisplay.delete(record.rtpTimestamp);
    record.displayAtHighRes = shown;
    state.joinedFrames += 1;
  }

  state.frames.push(record);
  state.byRtpTimestamp.set(record.rtpTimestamp, record);
  while (state.frames.length > FRAME_WINDOW) {
    const dropped = state.frames.shift();
    // Only if it is still the record under that key: a repeated rtpTimestamp must not
    // delete the newer frame's entry and silently stop the join.
    if (state.byRtpTimestamp.get(dropped.rtpTimestamp) === dropped) {
      state.byRtpTimestamp.delete(dropped.rtpTimestamp);
    }
  }
};

/**
 * Records one frame the receiver read (see readFrame). Pure state bookkeeping, shared by the
 * worker and main-thread routes.
 */
const recordReadFrame = (read) => {
  const { stamp } = read;
  if (stamp === null || stamp === undefined) {
    state.unstampedFrames += 1;
    return;
  }

  /*
   * A gap counts only between consecutive frames of the same rung. Sequences are per rung, and
   * the Engine re-originates every rendition under one SSRC, so only the stamp says which rung a
   * frame came from. A viewer joining a simulcast publish is handed one rung before settling on
   * another; a switch starts a new baseline rather than counting false losses.
   */
  if (state.lastRung === stamp.rung && state.lastSequence !== null) {
    state.missedFrames += countMissedFrames(state.lastSequence, stamp.sequence);
  }
  state.lastRung = stamp.rung;
  state.lastSequence = stamp.sequence;
  state.lastFrameAt = read.arrivedAt;
  state.stampedFrames += 1;

  remember({
    sequence: stamp.sequence,
    sentAt: stamp.sentAt,
    own: isOwnFrame(state.sentStamps, stamp),
    arrivedAt: read.arrivedAt,
    // Onto this page's performance timeline, which is the one rVFC reports on.
    arrivedAtHighRes: read.arrivedAtAbs - performance.timeOrigin,
    rtpTimestamp: read.rtpTimestamp,
    displayAtHighRes: null,
  });
};

/**
 * Player: read the stamp off every encoded video frame before it is decoded. The frame passes on
 * untouched, SEI included, since the decoder ignores a user_data_unregistered SEI.
 *
 * Returns { stop }.
 */
export const startReceiverProbe = (videoReceiver) => {
  const unavailable = probeUnavailableReason();
  if (unavailable || !videoReceiver || typeof videoReceiver.createEncodedStreams !== 'function') {
    state.receiverStatus = 'off';
    state.receiverReason = unavailable || 'No video receiver, so no frame stamp can be read.';
    logEvent('error', 'pc', 'latency probe not reading frames', state.receiverReason);
    emit();
    return { stop: () => {} };
  }

  /*
   * ontrack can fire more than once and the encoded stream can be taken only once per receiver,
   * so a repeat on the same receiver is a no-op. Keyed on the object, because a new play session
   * brings a new receiver that has to attach again.
   */
  if (state.receiver === videoReceiver) return { stop: () => {} };

  let stopped = false;
  const failure = { reported: false };
  resetMeasurements();
  state.receiver = videoReceiver;

  const attached = pipeEncodedStream(videoReceiver, {
    label: 'receiver',
    mainThread: () => new TransformStream({
      transform(frame, controller) {
        try {
          if (!stopped) recordReadFrame(readFrame(frame));
        } catch (error) {
          reportTransformFailure('receiver', error, failure);
        }
        controller.enqueue(frame);
      },
    }),
    worker: {
      op: 'receiver',
      initial: () => ({}),
      onMessage: (data) => {
        if (stopped || data.op !== 'frame') return;
        try {
          recordReadFrame(data);
        } catch (error) {
          reportTransformFailure('receiver', error, failure);
        }
      },
    },
    isStopped: () => stopped,
  });
  if (!attached.attached) {
    state.receiverStatus = 'off';
    state.receiverReason = attached.reason;
    // Forgotten again, so a later receiver on a fresh session is still allowed to try.
    state.receiver = null;
    emit();
    return { stop: () => {} };
  }

  state.receiverStatus = 'reading';
  state.receiverReason = null;
  startEmitting();

  return {
    stop: () => {
      stopped = true;
      attached.post({ op: 'stop' });
      state.receiverStatus = 'off';
      state.receiverReason = null;
      state.receiver = null;
      stopEmitting();
    },
  };
};

/**
 * Player: learn when each frame is put on screen.
 *
 * expectedDisplayTime is when the compositor intends to show the frame: a prediction, and the
 * last thing the browser can see. It shares the page's monotonic performance timeline with the
 * arrival time, so the player leg needs no offset; do not mix in Date.now(). Returns { stop }.
 */
export const attachProbeVideoElement = (videoElement) => {
  if (!videoElement || typeof videoElement.requestVideoFrameCallback !== 'function') {
    logEvent('error', 'pc', 'latency probe cannot see presented frames',
      'requestVideoFrameCallback is unavailable, so the decode and display leg is not measured.');
    return { stop: () => {} };
  }

  let stopped = false;
  let handle = null;

  const onFrame = (_now, metadata) => {
    if (stopped) return;
    const rtpTimestamp = metadata?.rtpTimestamp ?? null;
    if (rtpTimestamp !== null && typeof metadata.expectedDisplayTime === 'number') {
      const record = state.byRtpTimestamp.get(rtpTimestamp);
      if (record === undefined) {
        holdDisplay(rtpTimestamp, metadata.expectedDisplayTime);
      } else if (record.displayAtHighRes === null) {
        record.displayAtHighRes = metadata.expectedDisplayTime;
        state.joinedFrames += 1;
      }
    }
    handle = videoElement.requestVideoFrameCallback(onFrame);
  };

  handle = videoElement.requestVideoFrameCallback(onFrame);

  return {
    stop: () => {
      stopped = true;
      if (handle !== null && typeof videoElement.cancelVideoFrameCallback === 'function') {
        videoElement.cancelVideoFrameCallback(handle);
      }
    },
  };
};

/*
 * Wiring shared by both sides of the clock exchange. Arrival time is taken before parsing, so
 * JSON work is never counted as path delay. A channel that cannot open is logged, never thrown,
 * because both callers sit in the publish or play path; the player just shows no transport figure.
 */
const openClockChannel = (peerConnection, create, onMessage) => {
  try {
    return attachDataChannel(
      peerConnection,
      {
        onDataChannelMessage: ({ label, data }) => {
          if (label !== CLOCK_CHANNEL_LABEL) return;
          onMessage(data, Date.now());
        },
      },
      { label: CLOCK_CHANNEL_LABEL, create },
    );
  } catch (error) {
    logEvent('error', 'pc', 'latency probe clock channel unavailable',
      error?.message ?? String(error));
    return null;
  }
};

/**
 * Publisher: answer clock pings.
 *
 * The publisher creates the channel, because a data channel's m-line has to be in the first
 * offer and the Engine mirrors a publisher-created channel to every player (see
 * attachDataChannel). The reply carries arrival and send times so the player can subtract the
 * publisher's turnaround. Returns { close }.
 */
export const attachClockResponder = (peerConnection) => {
  const channel = openClockChannel(peerConnection, true, (data, arrivedAt) => {
    const ping = parseClockMessage(data);
    // A reply on this channel is our own echo coming back on a page running both arms.
    if (!ping || ping.kind !== 'ping') return;
    try {
      channel.send(buildClockReply({ ping, t1: arrivedAt, t2: Date.now() }));
    } catch (error) {
      logEvent('error', 'pc', 'latency probe clock reply failed', error?.message ?? String(error));
    }
  });

  return { close: () => channel?.close() };
};

// Ping cadence: fast until the estimator has MIN_SAMPLES, then slow. At one per second the
// 32-sample window holds half a minute.
const CLOCK_PING_FAST_MS = 250;
const CLOCK_PING_SLOW_MS = 1000;

/**
 * Player: run the clock exchange. The player needs the offset, so it asks and the publisher
 * answers, on the channel the Engine mirrors from the publisher. No transport figure until the
 * publisher also has the probe on. Returns { close }.
 */
export const attachClockInitiator = (peerConnection) => {
  let sequence = 0;
  let timer = null;
  let closed = false;
  const pending = new Map();
  const id = newClockSessionId();

  const channel = openClockChannel(peerConnection, false, (data, t3) => {
    const reply = parseClockMessage(data);
    // Only our own outstanding pings. Other viewers' replies arrive on this mirrored channel.
    if (!reply || reply.kind !== 'reply' || reply.id !== id) return;
    if (!pending.has(reply.sequence)) return;
    pending.delete(reply.sequence);

    // Oldest first, which is the order estimateOffset documents that it needs.
    state.clockSamples.push({ t0: reply.t0, t1: reply.t1, t2: reply.t2, t3 });
    if (state.clockSamples.length > WINDOW_SAMPLES) state.clockSamples.shift();
  });

  const tick = () => {
    if (closed || channel === null) return;
    // A closing or closed channel never answers; stop the timer chain even if nobody calls close().
    if (channel.readyState === 'closing' || channel.readyState === 'closed') return;
    try {
      const t0 = Date.now();
      channel.send(buildClockPing({ sequence, t0, id }));
      pending.set(sequence, t0);
      sequence += 1;
      // Unanswered pings must not accumulate; the window is all the history that matters.
      if (pending.size > WINDOW_SAMPLES) pending.delete(pending.keys().next().value);
    } catch {
      // Not open yet, or refused: retry. With no samples the clock already reports "cannot measure".
    }
    timer = setTimeout(tick,
      state.clockSamples.length < MIN_SAMPLES ? CLOCK_PING_FAST_MS : CLOCK_PING_SLOW_MS);
  };

  tick();

  return {
    close: () => {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      channel?.close();
    },
  };
};
