/*
 * The latency probe's encoded-frame transforms, off the main thread. One worker per sender or
 * receiver: latencyProbe.js calls createEncodedStreams, waits for "ready", and transfers the two
 * streams here. Timestamps are taken in this worker, so a busy page no longer moves time between
 * the two legs.
 *
 * Messages in:   { op: 'sender' | 'receiver', readable, writable, stamp }   start, once
 *                { op: 'stamp', stamp }                                      codec decision
 *                { op: 'stop' }                                              pass through
 * Messages out:  ready, sent { rung, sequence, sentAt }, refused { layout }, frame (see readFrame),
 *                error, ended
 */

import { createFrameStamper, readFrame } from './frameTransforms';

let wanted = false;
let stopped = false;
let reported = false;

// Said once, because a broken transform would otherwise say it 60 times a second.
const fail = (label, error) => {
  if (reported) return;
  reported = true;
  self.postMessage({ op: 'error', label, message: error?.message ?? String(error) });
};

const start = ({ op, readable, writable, stamp }) => {
  wanted = stamp === true;
  const stamper = createFrameStamper({
    onRefused: (layout) => self.postMessage({ op: 'refused', layout }),
  });

  const perFrame = op === 'sender'
    ? (frame) => {
      const sent = stamper(frame, wanted);
      if (sent) self.postMessage({ op: 'sent', ...sent });
    }
    : (frame) => self.postMessage({ op: 'frame', ...readFrame(frame) });

  readable
    .pipeThrough(new TransformStream({
      transform(frame, controller) {
        try {
          if (!stopped) perFrame(frame);
        } catch (error) {
          fail(op, error);
        }
        // The frame goes on in every case. A diagnostic must not drop media.
        controller.enqueue(frame);
      },
    }))
    .pipeTo(writable)
    .then(
      () => self.postMessage({ op: 'ended' }),
      (error) => self.postMessage({ op: 'ended', message: error?.message ?? String(error) }),
    );
};

self.onmessage = ({ data: message }) => {
  if (!message) return;
  if (message.op === 'stamp') wanted = message.stamp === true;
  else if (message.op === 'stop') stopped = true;
  else if (message.op === 'sender' || message.op === 'receiver') start(message);
};

self.postMessage({ op: 'ready' });
