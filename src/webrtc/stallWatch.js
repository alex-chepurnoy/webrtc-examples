/*
 * How a player notices a session the Engine has dropped under it. After an application
 * restart the player's connection stays up (its own RTCP keeps the Engine's side alive), so
 * nothing closes and ICE stays connected: the picture just freezes. What does change is
 * that no media arrives.
 *
 * Stalled means neither video nor audio bytes have grown for the whole window while
 * connected. Both, because each can be quiet on its own in a healthy stream: audio with DTX
 * sends very little, and while a static scene or a 1 fps screen share still sends video
 * bytes, a stream can be audio only. A stream with no audio at all is judged on video alone,
 * which is what "neither has grown" comes to when audio never reports.
 *
 * Not checked while an ICE restart is out: media is expected to stop while the path is
 * repaired, and the restart has its own limit. And not before any media has arrived at all:
 * a stream the Engine lists but whose publisher has sent nothing yet is waiting, not lost,
 * and replaying it would only find the same silence. What an application restart leaves is
 * media that was flowing and stopped.
 */

import { logEvent } from '../diagnostics/signalLog';
import { formatSeconds, reconnectTiming } from './sessionSupervisor';

export const STALL_MS = 10000;
// A stream with no audio has only video to go on, and a publisher's encoder can pause it for
// a few seconds on its own (a camera switch, a stalled capture), so it gets a longer window.
export const STALL_NO_AUDIO_MS = 20000;
export const STALL_POLL_MS = 2000;

/*
 * Before a stall is reported, the Engine is asked once whether the stream is still there
 * (checkStream). A publisher-side glitch leaves it listed, and a replay would only land on
 * the same stream, so the watch says so and gives it one more window. Missing, or no answer
 * to be had (the Engine refuses the question with 400 or 403), and the stall is reported.
 */
export const STREAM_LISTED = 'listed';

/** Total inbound bytes per kind in a stats report; null for a kind that never reported. */
export const inboundBytes = (report) => {
  const totals = { video: null, audio: null };
  if (!report || typeof report.forEach !== 'function') return totals;
  report.forEach((stat) => {
    if (!stat || stat.type !== 'inbound-rtp') return;
    const kind = stat.kind || stat.mediaType;
    if (kind !== 'video' && kind !== 'audio') return;
    totals[kind] = (totals[kind] || 0) + (Number(stat.bytesReceived) || 0);
  });
  return totals;
};

const grew = (before, after) => after != null && (before == null || after > before);

/**
 * Starts watching one peer connection. Returns the function that stops it.
 * onStall({ reason }) is called at most once.
 * checkStream: optional async () => 'listed' | anything else, asked once per stall.
 */
export const startStallWatch = ({
  role = 'play',
  peerConnection,
  isIceRestartInProgress,
  onStall,
  checkStream,
  streamName = '',
  now = () => Date.now(),
}) => {
  if (!peerConnection || typeof peerConnection.getStats !== 'function') return () => {};

  const stallMs = reconnectTiming('stallMs', STALL_MS);
  const noAudioStallMs = reconnectTiming('stallNoAudioMs', STALL_NO_AUDIO_MS);
  const pollMs = reconnectTiming('stallPollMs', STALL_POLL_MS);

  let stopped = false;
  let timer = null;
  let last = { video: null, audio: null };
  let lastGrowth = now();
  let seenMedia = false;
  let seenAudio = false;
  // Given one more window after the Engine said the stream is still listed.
  let graceGiven = false;

  const schedule = () => {
    if (!stopped) timer = setTimeout(check, pollMs);
  };

  async function check() {
    timer = null;
    if (stopped) return;

    // The window only runs while media is supposed to be flowing.
    if (peerConnection.connectionState !== 'connected'
        || (isIceRestartInProgress && isIceRestartInProgress())) {
      lastGrowth = now();
      schedule();
      return;
    }

    let report;
    try {
      report = await peerConnection.getStats();
    } catch {
      schedule();
      return;
    }
    if (stopped) return;

    const bytes = inboundBytes(report);
    if (grew(last.video, bytes.video) || grew(last.audio, bytes.audio)) {
      lastGrowth = now();
      graceGiven = false;
    }
    last = bytes;
    if ((bytes.video || 0) > 0 || (bytes.audio || 0) > 0) seenMedia = true;
    if ((bytes.audio || 0) > 0) seenAudio = true;
    if (!seenMedia) lastGrowth = now();

    const windowMs = seenAudio ? stallMs : noAudioStallMs;
    if (now() - lastGrowth < windowMs) {
      schedule();
      return;
    }

    if (checkStream && !graceGiven) {
      let answer = null;
      try { answer = await checkStream(); } catch { /* no answer is not an answer */ }
      if (stopped) return;
      if (answer === STREAM_LISTED) {
        graceGiven = true;
        lastGrowth = now();
        logEvent('warn', 'pc',
          `${role} media stalled but the stream${streamName ? ` "${streamName}"` : ''} is still on the Engine; waiting`,
          { waitingAnother: formatSeconds(windowMs) });
        schedule();
        return;
      }
    }

    stopped = true;
    logEvent('warn', 'pc',
      `${role} inbound media stalled for ${formatSeconds(windowMs)} while connected (possible session loss)`,
      { videoBytesReceived: bytes.video, audioBytesReceived: bytes.audio });
    onStall({ reason: `no media received for ${formatSeconds(windowMs)}` });
  }

  schedule();

  return () => {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
  };
};
