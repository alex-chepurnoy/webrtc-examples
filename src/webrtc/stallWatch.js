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
 * repaired, and the restart has its own limit.
 */

import { logEvent } from '../diagnostics/signalLog';
import { formatSeconds, reconnectTiming } from './sessionSupervisor';

export const STALL_MS = 10000;
export const STALL_POLL_MS = 2000;

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
 */
export const startStallWatch = ({
  role = 'play',
  peerConnection,
  isIceRestartInProgress,
  onStall,
  now = () => Date.now(),
}) => {
  if (!peerConnection || typeof peerConnection.getStats !== 'function') return () => {};

  const stallMs = reconnectTiming('stallMs', STALL_MS);
  const pollMs = reconnectTiming('stallPollMs', STALL_POLL_MS);

  let stopped = false;
  let timer = null;
  let last = { video: null, audio: null };
  let lastGrowth = now();

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
    if (grew(last.video, bytes.video) || grew(last.audio, bytes.audio)) lastGrowth = now();
    last = bytes;

    if (now() - lastGrowth >= stallMs) {
      stopped = true;
      logEvent('warn', 'pc',
        `${role} inbound media stalled for ${formatSeconds(stallMs)} while connected (possible session loss)`,
        { videoBytesReceived: bytes.video, audioBytesReceived: bytes.audio });
      onStall({ reason: `no media received for ${formatSeconds(stallMs)}` });
      return;
    }
    schedule();
  }

  schedule();

  return () => {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
  };
};
