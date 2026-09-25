import React, { useCallback, useRef } from 'react';

/*
 * What the readings mean, behind a button. The text must hold on both the player page and
 * the combined page. A <dialog> gives modality, focus containment, Escape and the backdrop.
 */

const MeasurementHelp = ({
  label = 'More info',
  // The visible label says nothing out of context, so the accessible name says what it opens.
  accessibleLabel = 'More info: how the latency figures are measured',
}) => {
  const dialog = useRef(null);

  const open = useCallback(() => dialog.current?.showModal(), []);
  const close = useCallback(() => dialog.current?.close(), []);

  // The backdrop is part of the dialog element, so a click on it lands on the dialog itself.
  const onBackdrop = useCallback((event) => {
    if (event.target === dialog.current) dialog.current.close();
  }, []);

  return (
    <>
      <button
        type="button"
        id="measurement-help-open"
        className="wz-help__open"
        aria-label={accessibleLabel}
        aria-haspopup="dialog"
        onClick={open}
      >
        {label}
      </button>

      <dialog
        ref={dialog}
        className="wz-help"
        id="measurement-help"
        aria-labelledby="measurement-help-title"
        onClick={onBackdrop}
      >
        <div className="wz-help__head">
          <h2 className="wz-help__title" id="measurement-help-title">
            How these numbers are measured
          </h2>
          <button
            type="button"
            className="wz-help__close"
            id="measurement-help-close"
            aria-label="Close"
            onClick={close}
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </div>

        <div className="wz-help__body">
          <table className="wz-help__table">
            <thead>
              <tr>
                <th scope="col">Reading</th>
                <th scope="col">Source</th>
                <th scope="col">What it is</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Round trip</th>
                <td>Measured, on the active ICE candidate pair</td>
                <td>This browser to the server and back.</td>
              </tr>
              <tr>
                <th scope="row">Latency</th>
                <td>Calculated</td>
                <td>Half the round trip, plus the jitter buffer.</td>
              </tr>
              <tr>
                <th scope="row">Publisher to player</th>
                <td>Measured, from a marker inside the frame</td>
                <td>
                  The median over up to the last 120 frames, from just after the
                  publisher&apos;s encoder to this player reading the frame off the wire.
                </td>
              </tr>
              <tr>
                <th scope="row">Player jitter buffer, decode and display</th>
                <td>Measured, in this browser</td>
                <td>
                  The median over the same frames, from reading the frame off the wire to the
                  moment the browser expects to show it.
                </td>
              </tr>
              <tr>
                <th scope="row">Total</th>
                <td>Measured, per frame</td>
                <td>
                  The median of the two legs added frame by frame, over the same frames. A median
                  of sums is not the sum of the medians, so it can differ from the two rows added
                  by a millisecond or two.
                </td>
              </tr>
              <tr>
                <th scope="row">Clock</th>
                <td>Proven, or estimated</td>
                <td>
                  How the publisher&apos;s clock relates to this one. See below.
                </td>
              </tr>
              <tr>
                <th scope="row">Frames missed</th>
                <td>Counted, from the marker</td>
                <td>
                  Gaps in the marker&apos;s sequence number within one simulcast rung, so a
                  publisher that stalls shows up here rather than as a latency that quietly
                  drifts upwards.
                </td>
              </tr>
            </tbody>
          </table>

          <h3>Round trip is not latency</h3>
          <p>
            It times a small probe packet, not a frame. A 1080p frame is many packets that have
            to be paced out, carried, reassembled and held until the next frame is due.
          </p>
          <p>
            A publisher and a player each measure their own round trip, and each one is a link
            between a browser and the server. Two of them on screen are not two halves of one
            path and do not add up.
          </p>

          <h3>Latency covers the last hop only</h3>
          <p>
            It is built from RTP and RTCP counters on this player&apos;s connection, which
            describe the leg from the server. The server originates the stream the player
            receives, so those counters do not reach back to the publisher. The arithmetic also
            assumes the path is symmetric.
          </p>

          <h3>The probe covers the whole path</h3>
          <p>
            Its timestamp travels inside the frame from the publisher. Publisher to player
            covers the publisher&apos;s packetization and pacing, both network legs, the server,
            and the wait for the last packet of the frame, retransmissions included. The wait in
            this player&apos;s jitter buffer comes after the frame is read, so it is in the
            player row. The Latency estimate sees only the last hop, which is why the two
            figures differ.
          </p>
          <p>
            Both ends read the frame in a background worker, so a busy page does not move time
            from one row to the other. Where a worker cannot start, the frame is read on the
            page itself; a busy player page then moves some of its own delay into Publisher to
            player. The total does not change either way.
          </p>

          <h3>Clock</h3>
          <p>
            The two legs are timed on two clocks. When every frame measured is one this page
            stamped itself, as on Publish + Play playing its own stream, there is one clock and
            the figures are exact. Otherwise the offset between the two clocks is estimated over
            a data channel and every figure that depends on it carries a plus or minus bound.
            Two tabs on one machine share a clock but cannot prove it, so they read exact only
            when the round trip to the server is a couple of milliseconds, as with a server on
            the same machine. The player row needs no clock and is shown in every case.
          </p>

          <h3>Packet loss is per direction</h3>
          <p>
            A publisher reports loss on the way up, as the server reported it back. A player
            reports loss on the way down. Zero on one side next to a figure on the other says
            which leg to look at.
          </p>
          <p>
            <code>Frames missed</code> counts frames that never reached the player. A lost packet
            is usually recovered by retransmission, which shows up as a slower frame rather than
            a missed one; a frame is missed when its packets could not be recovered in time, or
            when the publisher never sent it.
          </p>

          <h3>Not included anywhere</h3>
          <p>
            Camera sensor and image processing, the encoder queue ahead of the marker, and the
            display itself. The display time is the browser&apos;s prediction of when the frame
            will be shown, not an observation of it. The delay you can see by waving at the
            camera is larger than any figure here.
          </p>
        </div>
      </dialog>
    </>
  );
};

export default MeasurementHelp;
