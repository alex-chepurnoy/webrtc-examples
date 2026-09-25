![wowza media systems logo](images/wowza-logo.png)
# Wowza Media Systems WebRTC client examples

Welcome to the official Wowza Media Systems Web Real-time Communication (WebRTC) client examples. These examples cover four streaming scenarios:

- **Publish** — stream video and audio (or screen share) from a browser to Wowza Streaming Engine
- **Play** — play back a live WebRTC stream from Wowza Streaming Engine in a browser

## Contents

- [About WebRTC](#about-webrtc)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Set up WebRTC](#set-up-webrtc)
  - [What's new in v2](#whats-new-in-v2)
  - [Diagnostics in the v2 example](#diagnostics-in-the-v2-example)
  - [Glass-to-glass latency probe](#glass-to-glass-latency-probe)
  - [Combined publisher and player](#combined-publisher-and-player)
  - [Running the tests](#running-the-tests)
  - [Directory Structure](#directory-structure)
  - [Run the example code](#run-the-example-code)
- [Resources](#more-resources)
- [Contact](#contact-us)
- [License](#license)

## About WebRTC
WebRTC is an open source project to enable real-time communication of audio, video, and data in web browsers and native apps. WebRTC is designed for peer-to-peer connections but includes fallbacks in case direct connections fail. Encryption is mandatory for WebRTC streams, so you must host the examples on a web server using SSL encryption.

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 22.22.2 or later on the 22 line, 24.15.0 or later on 24, or 26 and later. The test toolchain (Vitest, jsdom) needs these; `npm ci` warns on anything older
- A running [Wowza Streaming Engine](https://www.wowza.com/docs/wowza-streaming-engine-product-articles) instance with WebRTC enabled

### Set up WebRTC
You'll need to set up WebRTC for Wowza Streaming Engine to run the examples. For more information, see [Set up WebRTC streaming with Wowza Streaming Engine](https://www.wowza.com/docs/how-to-use-webrtc-with-wowza-streaming-engine).

### What's new in v2

- **Updated engine WebRTC implementation** — v2 targets the modernized WebRTC implementation introduced in Wowza Streaming Engine 4.11, which includes WHIP/WHEP support, Trickle ICE, HEVC and VP9 codec support, and signaling modernization.
- **Configurable ICE servers** — STUN and TURN servers can now be set from the UI. Multiple servers can be provided as a comma-separated list. Credentials for TURN servers (username and password) are also configurable.
- **SecureToken support** — Wowza Secure Token hash generation is now available in the React example. The token is computed client-side using the Web Crypto API (SHA-256) and sent with the publish/play request. See `src/webrtc/SecureToken.js` for usage notes.
- **Form validation** — Required fields (application name and stream name) are validated before a connection is attempted, surfacing errors early instead of failing silently.
- **Current build toolchain** — v2 builds with [Vite](https://vite.dev/) on React 19, Redux Toolkit and Bootstrap 5.3. `npm install` reports no known vulnerabilities, `npm run build` produces no warnings, and no `--openssl-legacy-provider` workaround is needed. Bootstrap is installed from npm and bundled, and the handful of icons are inline SVG, so the built page loads nothing from a third-party CDN at runtime and waits on no icon font.

### Diagnostics in the v2 example

The publish and play pages each carry two diagnostic tools. The combined page carries both
sets, one per side.

**Connection statistics** sit under the video. `RTT` is measured: it is
`currentRoundTripTime` on the active ICE candidate pair. `Latency` is an **estimate**,
calculated as half the round trip time plus the jitter buffer delay over the last second, and it is
labelled as such on screen. It covers the network leg and the jitter buffer only. It does
**not** include capture, encode, processing inside Wowza Streaming Engine, decode, or the
display pipeline, so true glass-to-glass latency is higher than the figure shown. To
measure the whole path from the publisher's encoder instead of estimating around it, use the
[glass-to-glass latency probe](#glass-to-glass-latency-probe) below.

**Server communication** is a collapsible log of the exchange with the Engine: signaling
frames in both directions, the WHIP/WHEP HTTP calls, ICE candidates and peer-connection
state changes. It is collapsed by default, can be filtered by channel, and has a Copy
button for attaching to a support ticket.

### Glass-to-glass latency probe

The connection statistics above estimate the network leg from RTCP counters. The latency
probe measures something different: how long frames take from the publisher's encoder to
the player's screen, reported as the median over the last 120 frames or fewer, and split at
the point where the player reads the frame off the wire.

**It is a diagnostic, not a production metric.** It is off by default, it needs Chromium
and H.264, it installs a per-frame transform at both ends, and it reports nothing at all
when it cannot stand behind the number. Use it to answer "where is the latency going" on a
particular stream on a particular day. Do not put it on a dashboard and do not quote it as
a product specification.

Passthrough is the tested case. What a transcoding application does with the marker has not
been tested. Re-encoding is expected to drop it, in which case the player reads "no frame
stamp", which is correct but looks like a broken probe if you are not expecting it.

#### Turning it on

**Both ends need it on.** The publisher writes the marker, the player reads it. A player
with the probe on, watching a stream from a publisher without it, shows "No frame stamp in
this stream" rather than a number.

- **Publish page**, Advanced tab, `Latency Probe (frame stamp)`.
- **Play page**, Advanced tab, the same toggle.
- **Publish + Play page**, the Advanced tab of each side, since that page carries its own
  publisher and player settings.

The Latency group then appears in the **player's** statistics, under the video. There is
nothing to see on the publisher side; the publisher only stamps.

Two things to know:

- **The toggle takes effect on the next connect**, not immediately. The peer connection
  needs `encodedInsertableStreams` set when it is constructed, and the clock data channel
  needs its m-line in the first offer. Toggle it, then connect.
- **The setting travels in the share link.** That is how you set up a two-machine test:
  turn it on, copy the link, open it on the second machine.

#### What the two numbers mean

```
encode ->| stamp written |-> pace, network, Engine, network -> assemble |<- stamp read ->|
               t0                                                              t1
     -> jitter buffer -> decode -> display
                                     t2
```

| Row | What it covers |
|---|---|
| **Publisher to player** | `t1 - t0`. Publisher pacing and packetization, the network to the Engine, everything inside the Engine, the network to the player, and the wait until all of a frame's packets have arrived, retransmissions included. Both network legs are in it, so it is not the Engine's time alone. |
| **Player jitter buffer, decode and display** | `t2 - t1`. The wait in the jitter buffer, decode, compositing, and the wait until the frame is scheduled for display. |
| **Total** | `t2 - t0`, end to end minus camera capture, the encoder queue and panel emission. See [what the numbers exclude](#what-the-numbers-exclude). |
| **Clock** | Whether the two ends share a clock, and the uncertainty when they do not. See [Clocks](#clocks-and-why-the-testing-mode-matters). |
| **Frames missed** | Gaps in the stamp's sequence number, counted within one simulcast rung. A publisher that stalled shows up here as missed frames instead of as a plausible-looking latency. |

All three figures are medians over the same frames, the ones with both legs measured. A
median of sums is not the sum of the medians, so Total can differ from the two rows added by
a millisecond or two.

The jitter buffer sits in the player row because of where Chromium runs the receive
transform. In libwebrtc (`video/rtp_video_stream_receiver2.cc`) the transform runs in
`OnAssembledFrame`, once the packet buffer holds a whole frame, and the frame is only then
handed to `VideoReceiveStream2::OnCompleteFrame` and inserted into the frame buffer
(`VideoStreamBufferController`) that holds it until its render time.

Both transforms run in a worker: the encoded streams are transferred to
`src/diagnostics/latencyProbeWorker.js`, which takes both timestamps, so a busy page does not
move time from one row to the other. Where the worker cannot start, the transform runs on the
page and the Server communication log says so. There, a busy player page moves some of its
own delay from the player row into Publisher to player; the total is unaffected.

For reference, the figures seen while developing the probe, on the development Engine in
passthrough with publisher and player on one machine: a Publisher to player p50 of 107 to
109 ms across three sessions (the figure `e2e/latency.spec.js` prints as `transportP50`),
against a p50 of 7 ms with the Engine taken out of the path and the same instrument in both
arms. These are observations from one Engine on one day, not a result recorded in this
repository and not a specification.

#### Why the number is accurate

The stamp is a sequence number, a millisecond timestamp and a simulcast rung number written
into each encoded frame as an **H.264 SEI NAL** (`user_data_unregistered`, behind a 16-byte
marker UUID), using insertable streams. It is written after the encoder emits the frame,
after any access unit delimiter and parameter sets and in front of the first slice, as H.264
requires, and read before the decoder consumes it.

That placement is the entire point.

- **The marker rides inside the frame.** It passes through packetization, the network, the
  Engine and depacketization, which is every stage the picture passes through on the way to
  the player. The interval measured is therefore the interval the picture experienced, not a
  figure assembled from RTCP statistics describing a different part of the pipeline.
- **The encoder cannot corrupt it.** This is what defeats the obvious alternative, drawing
  a timestamp into the pixels. The pixel-stamp prototype, `src/utils/timecode.js`, is kept
  as a tested codec and is not used by the app. In the measurements taken while it was
  wired up it read 80% of frames at the source rendition, but only 8.7% once the encoder was
  told to halve the resolution with `scaleResolutionDownBy: 2`, and 22 of 300 on a simulcast
  rung. Worse than the loss rate, a pixel stamp fabricates confident wrong numbers on the
  frames it does manage to read, because a misread digit is still a digit. Over the same
  Engine and sessions the in-frame marker was found on every received frame: 187 of 187, 248
  of 248 and 248 of 248, over both WebSocket play and WHEP. The pixel-stamp figures come from
  a harness that is no longer in the repository; the marker figures are the kind
  `e2e/latency.spec.js` prints, which now also checks that each stamp the player reads
  matches, to the millisecond, one the publisher wrote.
- **It carries frame identity.** Every frame's stamp has a sequence number, so a gap is
  visible as a gap. An instrument with no frame identity cannot tell a four-second latency
  from a publisher that stopped four seconds ago.
- **It counts gaps per simulcast rung.** A simulcast publisher runs a separate sequence for
  each rung, and the rung travels in the stamp so the player can do the same. This matters
  because the Engine re-originates every rendition under one SSRC: without the rung in the
  stamp the player cannot tell one rung from another, and the switch a joining viewer makes
  from the rung it is handed first to the rung it settles on reads as several hundred lost
  frames. A gap is counted only between consecutive frames of the same rung, so the figure
  means "frames lost while watching one rung without interruption".
- **It joins to the frame that was actually shown.** The player matches a stamp to a
  presented frame on `rtpTimestamp`, which appears both on
  `RTCEncodedVideoFrame.getMetadata()` and in `requestVideoFrameCallback` metadata, so the
  display half of the figure belongs to the same frame as the transport half.
- **It does no harm to the stream.** The "injection does no harm" test in
  `e2e/latency.spec.js` compares stamped sessions with baseline sessions under the same
  conditions. In the runs made while developing it: `framesDropped` 0 in both, `freezeCount`
  0 in both, `pliCount` 4 in both, same decoder, same resolution, same frame rate.

Two timestamps the transport already offers were tried first and rejected. These are
observations from that investigation, against the development Engine; the scripts are not in
this repository. The `abs-capture-time` header extension was stripped by the Engine on all
four negotiation paths (WebSocket publish, WebSocket play, WHIP and WHEP), even when forced
into the offer with `setHeaderExtensionsToNegotiate`. The Engine's RTCP sender-report NTP
clock was wrong by 1.1 to 2.1 seconds against a 100 ms truth, and in one run by 50.5 days for
one of two simultaneous subscribers to the same stream. Neither could carry a timestamp. The
SEI marker needs no Engine-side work at all.

#### What the numbers exclude

Say this alongside any figure you quote from the probe. It is what makes the figure
trustworthy rather than merely small.

- **Camera sensor and ISP delay.** Everything before the browser is handed a frame.
- **The encoder's own queue.** `t0` is taken after the frame comes out of the encoder, so
  time a frame spent waiting to be encoded is invisible here.
- **Photon emission on the panel.** The display end of the measurement is
  `expectedDisplayTime` from `requestVideoFrameCallback`, which is the compositor's
  **prediction** of when the frame will be shown, not an observation that it was.

So the total is end to end minus capture, encode queue and panel. Real glass to glass is
higher, by a bias that is roughly fixed for a given machine and camera. Sizing that bias
takes a one-time calibration with a high frame rate camera (240 fps) pointed at both
screens at once. Until someone does that, quote the probe's number as what it measures and
not as glass to glass.

#### Clocks, and why the testing mode matters

`t0` is taken on the publisher's clock and `t1` on the player's. When those are two
different clocks, the difference between them lands directly in the Publisher to player row
and the total, so the probe has to say how much it trusts them. The player row subtracts two
readings of the player's own clock and needs no clock relationship at all, so it is shown in
every mode.

| How you are testing | Clock relationship | What the Clock row reads |
|---|---|---|
| Publish + Play, playing its own stream | One clock, proven: every frame measured is one this page stamped | **exact** (this page's own stream) |
| Two browsers or two tabs, one machine | The same OS clock, but nothing proves it | **exact** (one clock) when the round trip to the Engine is about 2 ms or less, as with a local Engine; otherwise **estimated**, plus or minus N ms |
| Two machines | Independent clocks | **estimated**, plus or minus N ms, always shown |

The first row is proven from the frames, not assumed: the page remembers every stamp it
wrote and claims one clock only when every frame in the window matches one of them in rung,
sequence and send time. The offset is then exactly zero, whatever the Engine's distance. A
page that publishes one stream and plays another is not in this row.

Two browsers on one machine share a clock, but the probe has no way to prove that. It
estimates the offset the same way as for two machines, and it can only call the result exact
when the estimate is within 2 ms of zero with a bound of 2 ms or less, which needs a round
trip of about 2 ms. Against a remote Engine the same setup reads as an estimate with its
bound, which is honest: it is an estimate.

For anything but the first row the probe estimates the offset over a dedicated `wz-clock`
data channel, NTP style, and keeps the lowest round trip in a rolling window, since the
fastest sample carries the least queuing asymmetry. The uncertainty shown is half that
minimum round trip plus 1 ms for the resolution of `Date.now()`, which bounds how far path
asymmetry can have pushed the estimate. It is shown on the Publisher to player row and the
total, so there is no bare figure in the two-machine case. For the first few seconds the
Clock row reads "syncing clocks". If the uncertainty is too large (over 30 ms), or the
estimate is unstable across the window, the probe shows "too uncertain to measure" and no
transport figure at all. A confidently wrong number is the failure this instrument exists to
remove.

One weakness of the estimate is worth stating plainly: a route that is consistently
asymmetric, such as an uplink much slower than the downlink on a phone hotspot, produces a
stable and confident offset estimate that is wrong, and no round-trip method can detect
that. The error stays inside the bound shown, but it is not zero.

#### Browser and codec support, today

- **Chromium only.** The probe uses `RTCRtpSender.createEncodedStreams()` and its receiver
  twin, which are Chrome specific, and moves the streams into a worker. The standards path,
  `RTCRtpScriptTransform`, is not used. In a browser without insertable streams the toggle is
  disabled and gives the reason, rather than failing at connect time.
- **H.264 only.** SEI NAL units are an H.264 construct. VP8 and VP9 have no equivalent, so
  there is nowhere to put the marker and prepending one would corrupt the frame. The
  publisher's video codec setting defaults to `auto`, where the Engine chooses from the
  offer, so the codec is not known until the session is up: `auto` leaves the toggle
  enabled, and if the negotiated codec turns out not to be H.264 the player reports "no
  frame stamp" instead of a number. The publisher also checks every frame and leaves any
  frame that does not parse as H.264 untouched. Selecting an explicit non-H.264 codec
  disables the toggle with the reason.

### Combined publisher and player

`Publish + Play` runs a publisher and a player side by side against the same Engine, each
with its own settings and its own statistics. The two are independent peer connections, so
their figures are per side and do not sum to a round-trip measurement.

### Running the tests

```bash
npm test          # unit tests (Vitest)
npm run test:e2e  # end-to-end tests (Playwright)
```

The end-to-end suite drives a real browser. It uses Chromium's fake capture device, so no
webcam is needed, and it talks to a real Wowza Streaming Engine. Point it at yours with:

```bash
# macOS / Linux
export WOWZA_SIGNALING_URL=wss://your-engine/webrtc-session.json
export WOWZA_APPLICATION=webrtc
```

```cmd
:: Windows (cmd)
set WOWZA_SIGNALING_URL=wss://your-engine/webrtc-session.json
set WOWZA_APPLICATION=webrtc
```

Tests that need an Engine skip themselves when one is not reachable, so the suite is still
useful without a server. It covers publish and play over both signalling paths, WHIP ingest and WHEP egress, the chat and captions data channels, the header status, the diagnostics panel and the stats graphs.

### Directory structure

The repository is a single React app. The legacy v1 examples (jQuery and the Redux-based React example) have been removed; they remain in the upstream repository's history.

- `src/components` — React components for the publish and play examples
    - `play` — Components for playing back a WebRTC stream
    - `publish` — Components for publishing a WebRTC stream
- `src/hooks`
    - `useMediaStream.js` — Custom hook for managing the active media stream ref
- `src/webrtc` — JavaScript files for managing the WebRTC setup
    - `SecureToken.js` — Builds a secure token hash
    - `getDevices.js`, `getUserMedia.js`, `getDisplayScreen.js` — Media device helpers
    - `replaceAudioTrack.js`, `replaceVideoTrack.js` — Track replacement utilities
    - `startPlay.js`, `stopPlay.js`, `startPublish.js`, `stopPublish.js` — Stream lifecycle helpers
- `src/utils` — Utility functions
    - `IceServersUtils.js` — Validation and configuration helpers for STUN/TURN ICE servers
    - `ValidationUtils.js` — Form validation utilities
    - `CookieUtils.js` — Cookie read/write helpers
- `src/actions`, `src/reducers` — Redux state management
- `e2e` — End-to-end tests (Playwright)
- `public` — Static assets copied into the build as is

### Run the example code

>	**Note:**
>   If you're not running the examples from `localhost`, an HTTPS connection is required for WebRTC to access local devices.

```bash
npm install
npm start
```

Go to `localhost:3000` to view the example.

## More resources

- [WebRTC workflows in Wowza Streaming Engine](https://www.wowza.com/docs/webrtc-workflows-in-wowza-streaming-engine)

## Contact us

Wowza Media Systems™, LLC

Wowza Media Systems provides developers with a platform to create streaming applications and solutions. See the [Wowza Developer Portal](https://www.wowza.com/resources/developers) to learn more about our APIs and SDKs.

## License

This code is distributed under the [BSD 3-Clause License](LICENSE.txt).
