import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

import {
  EMIT_INTERVAL_MS,
  STALE_MS,
  latencyProbeSupport,
  subscribe,
} from '../../diagnostics/latencyProbe';
import MeasurementHelp from './MeasurementHelp';
import Sparkline from './Sparkline';

/*
 * Publisher-to-player latency from the frame stamp, split into the transport leg (both network
 * legs and the Engine) and this browser's jitter buffer, decode and display leg. Display only:
 * it renders what latencyProbe.js reports and computes nothing. Stalled, unstamped, unsupported
 * and unsyncable states each get a visible form, and none of them may show a plausible number.
 *
 * Every row explains itself in visible text or in the More info dialog, never in a title
 * tooltip alone, which keyboard and touch users cannot reach.
 */

/*
 * The clock descriptor from the probe:
 *
 *   sample.clock = {
 *     state: 'ok' | 'unknown' | 'untrusted',
 *     mode: 'same-context' | 'same-clock' | 'cross-machine' | null,
 *     exact: boolean,               // true when both ends read one clock
 *     offsetMs: number | null,      // far clock minus this clock
 *     uncertaintyMs: number | null, // rtt_min / 2 plus the Date.now resolution
 *     warming: boolean,             // still collecting the first clock samples
 *     reason: string | null,        // set when the offset could not be trusted
 *   }
 *
 * A missing or unrecognized descriptor fails closed and suppresses the transport figures. The
 * player leg subtracts two readings of this browser's own clock and never needs the descriptor.
 */
/*
 * 'this page' because the probe proves it from the frames: every one in the window is one this
 * page stamped. 'one clock' rather than 'same machine': a zero offset says the ends share a
 * clock, not where the far end runs.
 */
const MODE_LABELS = {
  'same-context': "exact (this page's own stream)",
  'same-clock': 'exact (one clock)',
  'cross-machine': 'estimated across two machines',
};

/* Re-render cadence for the age of the last sample. */
const TICK_MS = 500;

/*
 * The probe marks a stall itself (status 'stalled', after STALE_MS). This covers the probe
 * itself going quiet: no sample for longer than a stall plus one emit interval.
 */
const SILENT_AFTER_MS = STALE_MS + EMIT_INTERVAL_MS;

/*
 * Grace period before a missing stamp is a finding: the first stamped frame needs a keyframe
 * and a pass through the Engine.
 */
const NO_STAMP_AFTER_MS = 3000;

/*
 * Points kept per figure: sixty samples at the probe's 500 ms emit is thirty seconds,
 * enough to see a climb or a spike settle, and the same point count the connection stats
 * keep, so the two sets of graphs read at the same grain.
 */
const HISTORY_LENGTH = 60;

const EMPTY_HISTORY = { transportMs: [], playerMs: [], totalMs: [] };

const msFormat = (value) => Math.round(value) + ' ms';

const ms = (value) =>
  value === null || value === undefined || Number.isNaN(value)
    ? '\u2014'
    : `${Math.round(value)} ms`;

/* What the total leaves out, short form. The long form is in the More info dialog. */
const TOTAL_EXCLUDES_SHORT =
  'Excludes camera capture, the encoder queue ahead of the stamp, and panel emission, so the '
  + 'delay you can see with your eyes is larger than this.';

/**
 * Turns the clock descriptor into something displayable, and says whether the figures beside
 * it may be shown at all.
 */
const describeClock = (clock) => {
  if (!clock || typeof clock !== 'object') {
    return {
      usable: false,
      text: 'not described',
      detail: 'The probe did not report how the publisher and player clocks relate, so the '
        + 'difference between the two timestamps cannot be read as a latency.',
    };
  }

  // The first seconds of a session, not a failure: say so rather than "too uncertain".
  if (clock.warming === true) {
    return {
      usable: false,
      warming: true,
      text: 'syncing clocks',
      detail: clock.reason || 'Exchanging clock samples with the publisher.',
    };
  }

  if (clock.reason) {
    return { usable: false, text: 'too uncertain to measure', detail: clock.reason };
  }

  if (clock.exact === true) {
    return {
      usable: true,
      exact: true,
      text: MODE_LABELS[clock.mode] || 'exact',
      detail: clock.mode === 'same-context'
        ? 'Every frame measured was stamped by this page, so both timestamps come from one '
          + 'clock and the difference between them is the latency and nothing else.'
        : 'The clock exchange found the two ends agreeing to within the resolution of the '
          + 'clock over a round trip of a couple of milliseconds, so the offset between them '
          + 'is too small to matter.',
    };
  }

  if (Number.isFinite(clock.uncertaintyMs)) {
    return {
      usable: true,
      exact: false,
      text: `\u00b1 ${Math.round(clock.uncertaintyMs)} ms`,
      uncertaintyMs: clock.uncertaintyMs,
      detail: 'The two ends have independent clocks. The offset is estimated over a data '
        + 'channel, and the bound shown is half the fastest round trip plus 1 ms of clock '
        + 'resolution: the most a one-way figure taken from a round trip can be wrong by when '
        + 'the two directions are not equally fast. It applies to the publisher to player row '
        + 'and the total, not to the player row.',
    };
  }

  return {
    usable: false,
    text: 'unknown',
    detail: 'The clock descriptor carried neither an exact-clock flag nor an uncertainty, so '
      + 'how far apart the two clocks sit is unknown.',
  };
};

/* Head and table follow the simulcast layer panel, so the two read as one family. */
const Shell = ({ summary, summaryTone, children }) => (
  <div className="wz-latency" id="latency-group">
    <div className="wz-latency__head">
      <span className="wz-latency__title">Frame stamp latency</span>
      {/* In the head so it is present in every state of the panel. */}
      <MeasurementHelp />
      {summary ? (
        <span
          className={'wz-latency__summary' + (summaryTone ? ' wz-latency__summary--' + summaryTone : '')}
        >
          {summary}
        </span>
      ) : null}
    </div>
    {children}
  </div>
);

const Row = ({ label, note, value, muted, history }) => (
  <tr className={muted ? 'wz-latency__row--muted' : undefined}>
    <th scope="row">
      {/* The shape sits at the right of the label cell, just left of the right-aligned
          number, in whatever width the label leaves; with too little it is not drawn. Under
          two points there is nothing to draw, and nothing is drawn. */}
      <div className="wz-latency__label-row">
        <span className="wz-latency__label">
          {label}
          {note ? <span className="wz-latency__note">{note}</span> : null}
        </span>
        {history && history.length >= 2 ? (
          <Sparkline points={history} format={msFormat} ariaLabel={label + ' history'} />
        ) : null}
      </div>
    </th>
    <td className="wz-latency__value">{value}</td>
  </tr>
);

/*
 * Why there is no stamp. The stamp is H.264 only, so a known non-H.264 codec is named as the
 * cause.
 */
const noStampReason = (videoCodec) => {
  const codec = String(videoCodec || '').trim();
  if (codec !== '' && !/^h\.?264$/i.test(codec)) {
    return `This stream is ${codec}, and the frame stamp is an H.264 SEI NAL. Nothing else `
      + 'carries one. Set Video Codec to H.264 on the publisher: on Auto the server picks, and '
      + 'this one picked something else.';
  }
  return 'No frame stamp in this stream. Either the publisher does not have the probe on '
    + '(both ends need it), or something between the two re-encoded the video and dropped the '
    + 'marker. A transcoding application reads exactly like this.';
};

const LatencyGroup = ({ connected, videoCodec = null }) => {
  const enabled = useSelector((state) => state.playSettings.latencyProbe) === true;

  const [sample, setSample] = useState(null);
  const [history, setHistory] = useState(EMPTY_HISTORY);
  const [receivedAt, setReceivedAt] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const listening = enabled && connected;

  useEffect(() => {
    if (!listening) {
      // So a figure from the previous session cannot reappear as this one's.
      setSample(null);
      setHistory(EMPTY_HISTORY);
      return undefined;
    }

    setStartedAt(Date.now());
    setNow(Date.now());

    const unsubscribe = subscribe((next) => {
      // A replayed null before the first frame is not a sample and must not end the grace period.
      if (!next) return;
      setSample(next);
      setReceivedAt(Date.now());
      // History keeps only figures the panel would have shown. A transport or total figure
      // whose clock the probe cannot stand behind never becomes part of the shape either.
      // The player leg needs no clock, so it is kept either way.
      const clockUsable = describeClock(next.clock).usable;
      setHistory((prev) => {
        const push = (list, value) => {
          if (!Number.isFinite(value)) return list;
          const grown = [...list, value];
          return grown.length > HISTORY_LENGTH ? grown.slice(grown.length - HISTORY_LENGTH) : grown;
        };
        return {
          transportMs: clockUsable ? push(prev.transportMs, next.transportMs) : prev.transportMs,
          playerMs: push(prev.playerMs, next.playerMs),
          totalMs: clockUsable ? push(prev.totalMs, next.totalMs) : prev.totalMs,
        };
      });
    });

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [listening]);

  // Stall and grace period are wall-time checks, so re-render without a new sample.
  useEffect(() => {
    if (!listening) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [listening]);

  if (!enabled) return null;

  /*
   * Checked even though the toggle is disabled here: a cookie or share link can turn the flag
   * on in a browser that cannot honor it.
   */
  const support = latencyProbeSupport();
  if (!support.supported) {
    return (
      <Shell summary="unavailable" summaryTone="bad">
        <p className="wz-latency__caveat">{support.reason}</p>
      </Shell>
    );
  }

  if (!sample) {
    if (!connected) return null;

    const waiting = now - startedAt < NO_STAMP_AFTER_MS;
    return (
      <Shell summary={waiting ? 'waiting' : 'no stamp'} summaryTone={waiting ? null : 'bad'}>
        <p className="wz-latency__caveat">
          {waiting ? 'Waiting for the first stamped frame.' : noStampReason(videoCodec)}
        </p>
      </Shell>
    );
  }

  const clock = describeClock(sample.clock);
  // A stall is the probe's call; SILENT_AFTER_MS only covers the probe itself going quiet.
  const stale = sample.status === 'stalled' || now - receivedAt > SILENT_AFTER_MS;
  const frameAge = now - (Number.isFinite(sample.lastFrameAt) ? sample.lastFrameAt : receivedAt);
  const missed = Number.isFinite(sample.missedFrames) ? sample.missedFrames : null;

  /*
   * A stalled sample was a real measurement, so its figures stay, grayed, for as long as the
   * session is connected; the panel goes when the session stops. The transport leg and the
   * total need a usable clock. The player leg does not, so it shows whenever it was measured.
   */
  const bound = clock.usable && !clock.exact && Number.isFinite(clock.uncertaintyMs)
    ? ` \u00b1 ${Math.round(clock.uncertaintyMs)} ms`
    : '';
  const needsClock = (value) => {
    if (!clock.usable || value === null || value === undefined) return '\u2014';
    return `${ms(value)}${bound}`;
  };

  // The head shows only what the rows cannot: that the figures are stale.
  const summary = stale ? `no stamped frame for ${(frameAge / 1000).toFixed(1)} s` : null;

  return (
    <Shell summary={summary} summaryTone={stale ? 'bad' : null}>
      <table className={'wz-latency__table' + (stale ? ' wz-latency__table--stale' : '')}>
        <tbody>
          <Row
            label="Publisher to player"
            note="network, Engine, network"
            value={needsClock(sample.transportMs)}
            history={clock.usable ? history.transportMs : null}
          />
          <Row
            label="Player jitter buffer, decode and display"
            note="this browser"
            value={ms(sample.playerMs)}
            history={history.playerMs}
          />
          <Row
            label="Total"
            note="stamp to expected display"
            value={needsClock(sample.totalMs)}
            history={clock.usable ? history.totalMs : null}
          />
          <Row
            label="Clock"
            note={clock.usable ? null : 'no transport figure without this'}
            value={clock.text}
            muted={!clock.usable && !clock.warming}
          />
          <Row
            label="Frames missed"
            note={Number.isFinite(sample.lastSequence)
              ? `gaps in the stamp sequence, last stamp ${sample.lastSequence}`
              : 'gaps in the stamp sequence'}
            value={missed === null ? '\u2014' : String(missed)}
          />
        </tbody>
      </table>

      {/* The stale warning and the clock's own explanation are never hidden behind the button. */}
      <p className="wz-latency__caveat">
        {stale
          ? `Last stamped frame ${(frameAge / 1000).toFixed(1)} s ago, so these figures describe `
            + 'a frame that is no longer on screen. '
          : ''}
        {clock.usable && clock.exact ? '' : `${clock.detail} `}
        {TOTAL_EXCLUDES_SHORT}
      </p>
    </Shell>
  );
};

export default LatencyGroup;
