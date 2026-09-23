import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from '@playwright/test';
import {
  APPLICATION,
  SIGNALING_URL,
  httpOrigin,
  requireEngine,
  uniqueStream,
} from './helpers.js';
import {
  expectLive,
  expectPlaying,
  openTab,
  startPlaying,
  startPublishing,
  waitForCamera,
} from './ui-helpers.js';

/*
 * The frame stamp (the H.264 SEI NAL in src/utils/frameStamp.js) against a live Engine.
 *
 * The transforms are injected from an init script, not through the Latency Probe toggle.
 * encodedInsertableStreams can only be set when the RTCPeerConnection is constructed, so the
 * constructor is wrapped and transforms attach at addTrack/addTransceiver time, counting every
 * frame from the first. Tests that drive the toggle skip with a named reason when it is absent.
 *
 * Clocks: publisher and player share one machine (design modes A and B), so Date.now() agrees
 * and no offset estimate is involved. Mode C (two machines) is not automatable here.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/*
 * The real codec, read at test time so these tests follow any wire-format change.
 * frameStamp.js has no imports, so stripping `export ` makes it a classic script.
 */
const frameStampSource = () => {
  const file = path.join(here, '..', 'src', 'utils', 'frameStamp.js');
  const source = fs.readFileSync(file, 'utf8');
  if (!source.includes('export const insertStamp')) {
    throw new Error(`frameStamp.js at ${file} no longer exports insertStamp`);
  }
  return source.replace(/^export /gm, '');
};

/**
 * The init script: forces insertable streams on, and attaches the stamp and the reader.
 *
 * `stamp` false is the baseline: transforms attached and counting, nothing written.
 * `dropEvery` discards every Nth frame after advancing its sequence number, because loopback
 * against this Engine loses nothing.
 */
const instrument = ({ stamp = true, dropEvery = 0 } = {}) => `
${frameStampSource()}

window.__wz = {
  stamp: ${stamp ? 'true' : 'false'},
  dropEvery: ${Number(dropEvery)},
  pcs: [],
  sent: [],
  frames: [],
  presented: [],
  byRtp: new Map(),
  senders: 0,
  receivers: 0,
  ridSeen: false,
  log: [],
};

(() => {
  const W = window.__wz;
  const Native = window.RTCPeerConnection;

  const note = (message) => { W.log.push(message); };

  const attachSender = (sender) => {
    if (!sender || !sender.track || sender.track.kind !== 'video' || sender.__wz) return;
    if (typeof sender.createEncodedStreams !== 'function') { note('sender: no createEncodedStreams'); return; }
    sender.__wz = true;
    let streams;
    try { streams = sender.createEncodedStreams(); }
    catch (error) { note('sender createEncodedStreams: ' + error.message); return; }
    W.senders += 1;

    /*
     * One sequence per simulcast rung. A single counter across a three-rung sender arrives at
     * the player full of gaps and reports a stalling publisher that was fine.
     *
     * The rung is identified by synchronizationSource, NOT by rid and NOT by spatialIndex.
     * Measured on 2026-09-17, Chromium 1.63 bundled with Playwright, against a three-rung
     * h/m/l publish: rid was undefined on all 204 sampled frames and spatialIndex was 0 on
     * all of them, while synchronizationSource took a distinct value per rung and tracked the
     * frame sizes (320x240 and 640x480 arriving under different SSRCs). getParameters() still
     * reports rid h, m and l on the encodings, so the rid exists; it just does not reach
     * RTCEncodedVideoFrame.getMetadata().
     */
    const counters = new Map();
    // The one-byte rung index the stamp carries, in order of first appearance, as the app does.
    const rungIndices = new Map();
    const rungIndexOf = (rung) => {
      if (!rungIndices.has(rung)) rungIndices.set(rung, Math.min(rungIndices.size, 255));
      return rungIndices.get(rung);
    };
    let seen = 0;

    const transformer = new TransformStream({
      transform(frame, controller) {
        try {
          seen += 1;
          const meta = typeof frame.getMetadata === 'function' ? frame.getMetadata() : {};
          if (meta.rid != null) W.ridSeen = true;
          const rung = meta.synchronizationSource != null ? 'ssrc:' + meta.synchronizationSource
            : (meta.rid != null ? meta.rid
              : (meta.spatialIndex != null ? 's' + meta.spatialIndex : 'one'));
          const advance = () => {
            const next = (counters.get(rung) || 0) + 1;
            counters.set(rung, next);
            return next;
          };

          if (W.dropEvery > 0 && seen % W.dropEvery === 0) {
            // The sequence advances and the frame does not leave, which is what real loss
            // looks like from the player's side.
            W.sent.push({ rung, seq: advance(), dropped: true });
            return;
          }

          if (W.stamp) {
            const seq = advance();
            const sentAt = Date.now();
            const rungIndex = rungIndexOf(rung);
            // The app's own placement: after any AUD, SPS and PPS, in front of the first slice.
            const out = insertStamp(new Uint8Array(frame.data), { sequence: seq, sentAt, rung: rungIndex });
            if (out === null) {
              note('sender: a frame did not parse as H.264 and went out unstamped');
              W.sent.push({ rung, seq, bare: true });
            } else {
              frame.data = out.buffer;
              W.sent.push({
                rung, rungIndex, seq, sentAt,
                rtp: meta.rtpTimestamp != null ? meta.rtpTimestamp : null,
                keyFrame: frame.type === 'key',
                bytes: out.length,
              });
            }
          } else {
            W.sent.push({ rung, seq: advance(), bare: true });
          }
        } catch (error) { note('sender transform: ' + error.message); }
        controller.enqueue(frame);
      },
    });

    streams.readable.pipeThrough(transformer).pipeTo(streams.writable)
      .catch((error) => note('sender pipe: ' + error.message));
  };

  const attachReceiver = (receiver) => {
    if (!receiver || receiver.__wz) return;
    if (!receiver.track || receiver.track.kind !== 'video') return;
    if (typeof receiver.createEncodedStreams !== 'function') { note('receiver: no createEncodedStreams'); return; }
    receiver.__wz = true;
    let streams;
    try { streams = receiver.createEncodedStreams(); }
    catch (error) { note('receiver createEncodedStreams: ' + error.message); return; }
    W.receivers += 1;

    const transformer = new TransformStream({
      transform(frame, controller) {
        try {
          const arrivedAt = Date.now();
          const arrivedHi = performance.now();
          const meta = typeof frame.getMetadata === 'function' ? frame.getMetadata() : {};
          /*
           * rtpTimestamp is the join key because it is the only field that appears on both
           * RTCEncodedVideoFrame.getMetadata() and requestVideoFrameCallback's metadata.
           * frame.timestamp is the older spelling of the same number and is read as a
           * fallback so a browser carrying one but not the other still joins.
           */
          const rtp = meta.rtpTimestamp != null ? meta.rtpTimestamp
            : (frame.timestamp != null ? frame.timestamp : null);
          const found = findSeiPayload(frame.data);
          const record = {
            arrivedAt,
            arrivedHi,
            rtp,
            bytes: frame.data.byteLength,
            keyFrame: frame.type === 'key',
            seq: found ? found.sequence : null,
            sentAt: found ? found.sentAt : null,
            rung: found ? found.rung : null,
            displayHi: null,
          };
          W.frames.push(record);
          if (rtp !== null) W.byRtp.set(rtp, record);
        } catch (error) { note('receiver transform: ' + error.message); }
        controller.enqueue(frame);
      },
    });

    streams.readable.pipeThrough(transformer).pipeTo(streams.writable)
      .catch((error) => note('receiver pipe: ' + error.message));
  };

  function Wrapped(config, ...rest) {
    const merged = Object.assign({}, config || {}, { encodedInsertableStreams: true });
    const pc = new Native(merged, ...rest);
    W.pcs.push(pc);
    // Registered here so it runs before the application assigns its own ontrack, which
    // matters on the paths where the receiver first appears in the track event.
    pc.addEventListener('track', (event) => {
      if (event.receiver) attachReceiver(event.receiver);
    });
    return pc;
  }
  Wrapped.prototype = Native.prototype;
  window.RTCPeerConnection = Wrapped;

  const origAddTrack = Native.prototype.addTrack;
  Native.prototype.addTrack = function addTrackHooked(...args) {
    const sender = origAddTrack.apply(this, args);
    try { attachSender(sender); } catch (error) { note('addTrack hook: ' + error.message); }
    return sender;
  };

  const origAddTransceiver = Native.prototype.addTransceiver;
  Native.prototype.addTransceiver = function addTransceiverHooked(...args) {
    const transceiver = origAddTransceiver.apply(this, args);
    try {
      attachSender(transceiver.sender);
      attachReceiver(transceiver.receiver);
    } catch (error) { note('addTransceiver hook: ' + error.message); }
    return transceiver;
  };
})();
`;

/** Starts the presented-frame join on a video element. Returns false when rVFC is absent. */
const joinPresentedFrames = (page, selector) =>
  page.evaluate((sel) => {
    const W = window.__wz;
    const video = document.querySelector(sel);
    if (!video || typeof video.requestVideoFrameCallback !== 'function') {
      W.log.push('no requestVideoFrameCallback on ' + sel);
      return false;
    }
    W.presented = [];
    const onFrame = (_now, meta) => {
      const rtp = meta && meta.rtpTimestamp != null ? meta.rtpTimestamp : null;
      const record = rtp === null ? undefined : W.byRtp.get(rtp);
      if (record && record.displayHi === null && typeof meta.expectedDisplayTime === 'number') {
        record.displayHi = meta.expectedDisplayTime;
      }
      W.presented.push({
        rtp,
        joined: !!record,
        stampedMatch: !!(record && record.seq !== null),
        hasExpected: !!(meta && typeof meta.expectedDisplayTime === 'number'),
      });
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    return true;
  }, selector);

/** Everything the instrument accumulated, pulled back into Node for the arithmetic. */
const readInstrument = (page) =>
  page.evaluate(() => {
    const W = window.__wz;
    const byRung = {};
    for (const s of W.sent) byRung[s.rung] = (byRung[s.rung] || 0) + 1;
    return {
      log: W.log,
      ridSeen: W.ridSeen,
      senders: W.senders,
      receivers: W.receivers,
      peerConnections: W.pcs.length,
      sentTotal: W.sent.length,
      sentByRung: byRung,
      sentDropped: W.sent.filter((s) => s.dropped).length,
      // What the publisher actually wrote, so a player's reading can be checked against it.
      sentStamps: W.sent.filter((s) => typeof s.sentAt === 'number')
        .map((s) => ({ rungIndex: s.rungIndex, seq: s.seq, sentAt: s.sentAt })),
      frames: W.frames.map((f) => ({
        arrivedAt: f.arrivedAt, arrivedHi: f.arrivedHi, rtp: f.rtp, bytes: f.bytes,
        keyFrame: f.keyFrame, seq: f.seq, sentAt: f.sentAt, rung: f.rung, displayHi: f.displayHi,
      })),
      presented: W.presented.length,
      presentedJoined: W.presented.filter((p) => p.joined).length,
      presentedWithRtp: W.presented.filter((p) => p.rtp !== null).length,
      presentedWithExpected: W.presented.filter((p) => p.hasExpected).length,
    };
  });

/** Inbound video stats off whichever peer connection has them, for the do-no-harm comparison. */
const inboundVideoStats = (page) =>
  page.evaluate(async () => {
    for (const pc of window.__wz.pcs) {
      const report = await pc.getStats();
      let inbound = null;
      report.forEach((entry) => {
        if (entry.type === 'inbound-rtp' && entry.kind === 'video') inbound = entry;
      });
      if (!inbound) continue;
      let mimeType = null;
      report.forEach((entry) => { if (entry.id === inbound.codecId) mimeType = entry.mimeType; });
      return {
        mimeType,
        framesDecoded: inbound.framesDecoded ?? null,
        framesDropped: inbound.framesDropped ?? null,
        freezeCount: inbound.freezeCount ?? null,
        pliCount: inbound.pliCount ?? null,
        nackCount: inbound.nackCount ?? null,
        packetsLost: inbound.packetsLost ?? null,
        frameWidth: inbound.frameWidth ?? null,
        frameHeight: inbound.frameHeight ?? null,
        framesPerSecond: inbound.framesPerSecond ?? null,
      };
    }
    return null;
  });

const median = (values) => {
  const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  // Lower middle, so the figure printed is one some frame actually had.
  return sorted.length === 0 ? null : sorted[Math.floor((sorted.length - 1) / 2)];
};

const percentile = (values, p) => {
  const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

/** The numbers every test prints, so a run's output is the measurement rather than a verdict. */
const summarize = (label, data) => {
  const stamped = data.frames.filter((f) => f.seq !== null);
  const transport = stamped.map((f) => f.arrivedAt - f.sentAt);
  const player = stamped.filter((f) => f.displayHi !== null).map((f) => f.displayHi - f.arrivedHi);
  const total = stamped
    .filter((f) => f.displayHi !== null)
    .map((f) => (f.arrivedAt - f.sentAt) + (f.displayHi - f.arrivedHi));

  // Gaps, per the module's own rule: a jump of more than one is loss, a repeat or a step
  // backwards is reorder or duplication and counts as nothing.
  let missed = 0;
  let previous = null;
  for (const frame of stamped) {
    if (previous !== null && frame.seq > previous) missed += frame.seq - previous - 1;
    previous = frame.seq;
  }

  const summary = {
    label,
    framesReceived: data.frames.length,
    framesStamped: stamped.length,
    markerRate: data.frames.length === 0 ? null : stamped.length / data.frames.length,
    sentTotal: data.sentTotal,
    sentByRung: data.sentByRung,
    sentDropped: data.sentDropped,
    missedFrames: missed,
    presented: data.presented,
    presentedJoined: data.presentedJoined,
    joinRate: data.presented === 0 ? null : data.presentedJoined / data.presented,
    transportP50: median(transport),
    transportP90: percentile(transport, 0.9),
    transportMin: transport.length ? Math.min(...transport) : null,
    transportMax: transport.length ? Math.max(...transport) : null,
    playerP50: median(player),
    totalP50: median(total),
    senders: data.senders,
    receivers: data.receivers,
    ridSeen: data.ridSeen,
    log: data.log,
  };
  console.log(`\n--- ${label} ---\n${JSON.stringify(summary, null, 2)}`);
  return summary;
};

/*
 * A marker rate of 1 says every frame carried something; this says it carried what the publisher
 * wrote. Every stamp the player read is joined to the publisher's record by rung and sequence,
 * and the send time has to match to the millisecond, so a stamp the Engine mangled, re-used or
 * re-numbered fails here. Both ends read one machine's Date.now, so transport also has to be a
 * plausible positive figure.
 */
const expectStampsFromPublisher = (publisherData, playerData, label) => {
  const written = new Map(publisherData.sentStamps.map((s) => [`${s.rungIndex}:${s.seq}`, s.sentAt]));
  const stamped = playerData.frames.filter((f) => f.seq !== null);
  expect(stamped.length, `${label}: the player read no stamps`).toBeGreaterThan(30);

  const unknown = stamped.filter((f) => !written.has(`${f.rung}:${f.seq}`));
  expect(unknown.slice(0, 5), `${label}: stamps the publisher never wrote (rung:seq)`).toEqual([]);

  const altered = stamped.filter((f) => written.get(`${f.rung}:${f.seq}`) !== f.sentAt);
  expect(altered.slice(0, 5), `${label}: stamps whose send time changed on the way`).toEqual([]);

  const transport = stamped.map((f) => f.arrivedAt - f.sentAt);
  expect(Math.min(...transport), `${label}: a frame arrived before it was sent`).toBeGreaterThan(0);
  expect(Math.max(...transport), `${label}: an implausible transport time`).toBeLessThan(1000);
  return { stamped: stamped.length, rungs: [...new Set(stamped.map((f) => f.rung))] };
};

// Each context gets its own instrument: the publisher's counts what it stamped, the player's
// what it read.
const newInstrumentedContext = async (browser, options) => {
  const context = await browser.newContext();
  await context.addInitScript(instrument(options));
  return context;
};

/** Publishes a stream with the stamp on, H.264 forced, and waits for LIVE. */
const publishStamped = async (page, { streamName, useWhip = false, simulcast = false }) => {
  await page.goto('/#/publish');
  await requireEngine(page, test);
  if (simulcast) {
    await waitForCamera(page);
    await openTab(page, 'Source');
    await page.locator('#publishUseSimulcast').check();
    await openTab(page, 'Connection');
  }
  // H.264 explicitly. The stamp is an SEI NAL and no other codec here carries one, so a run
  // that negotiated VP8 would report a 0% marker rate that says nothing about the Engine.
  await startPublishing(page, { streamName, useWhip, codec: 'H264' });
  await expectLive(page);
};

/*
 * Retries Play until playback starts. The Engine lists <name>_m and <name>_l several seconds
 * before it serves them, and even a plain wss play intermittently fails on the first click.
 * The toggle is reset between attempts because a half-started session leaves it at "Stop".
 */
const playWithRetry = async (page) => {
  await expect(async () => {
    const toggle = page.locator('#play-toggle');
    if ((await toggle.innerText()).trim().toLowerCase() === 'stop') {
      await toggle.click();
      await page.waitForTimeout(500);
    }
    await toggle.click();
    await expect(page.locator('#video-play-indicator')).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 90_000 });
};

/** Fills the play form without pressing Play, so the caller can drive the retry. */
const fillPlayForm = async (page, { streamName, useWhep = false }) => {
  if (useWhep) await page.locator('#playUseWhep').check();
  await page.fill('#playSignalingURL', useWhep ? httpOrigin() : SIGNALING_URL);
  await page.fill('#playApplicationName', APPLICATION);
  await page.fill('#playStreamName', streamName);
};

/** Plays a stream on the play page and waits for the PLAYING badge. */
const playStamped = async (page, { streamName, useWhep = false }) => {
  await page.goto('/#/play');
  await fillPlayForm(page, { streamName, useWhep });
  await playWithRetry(page);
};

/** Picks one simulcast rung from the Engine's own rendition list and plays it. */
const waitForRendition = async (page, streamName, rung) => {
  await page.goto('/#/play');
  await page.fill('#playSignalingURL', SIGNALING_URL);
  await page.fill('#playApplicationName', APPLICATION);
  await page.fill('#playStreamName', streamName);
  const select = page.locator('#playRendition');
  await expect(async () => {
    await page.click('#play-find-renditions');
    await expect(select).toBeEnabled({ timeout: 3_000 });
  }).toPass({ timeout: 40_000 });
  const labels = (await select.locator('option').allTextContents()).join(' ');
  expect(labels, `rendition "${rung}" never appeared for ${streamName}`).toMatch(new RegExp(`"${rung}"`));
  await select.selectOption(`${streamName}_${rung}`);
  await expect(page.locator('#playStreamName')).toHaveValue(`${streamName}_${rung}`);
  await playWithRetry(page);
};

/* ============================================================ the marker survives ========= */

test.describe('the frame stamp survives the Engine', () => {
  test('wss publish to wss play: every received frame carries the marker', async ({ browser }) => {
    test.setTimeout(150_000);
    const pubContext = await newInstrumentedContext(browser);
    const playContext = await newInstrumentedContext(browser);
    const publisher = await pubContext.newPage();
    const viewer = await playContext.newPage();

    try {
      const streamName = uniqueStream('seiws');
      await publishStamped(publisher, { streamName });
      await playStamped(viewer, { streamName });
      await joinPresentedFrames(viewer, '#player-video');
      await viewer.waitForTimeout(10_000);

      const stats = await inboundVideoStats(viewer);
      const publisherData = await readInstrument(publisher);
      const playerData = await readInstrument(viewer);
      const sent = summarize('wss -> wss, publisher', publisherData);
      const read = summarize('wss -> wss, player', playerData);
      console.log(`inbound stats: ${JSON.stringify(stats)}`);

      // Without H.264 the marker question is meaningless, so this is checked before it.
      expect(stats?.mimeType, 'the session has to be H.264 for an SEI to exist').toMatch(/H264/i);
      expect(sent.sentTotal, 'the publisher stamped nothing').toBeGreaterThan(30);
      expect(read.framesReceived, 'no encoded frames reached the player').toBeGreaterThan(30);
      expect(read.markerRate).toBe(1);
      expectStampsFromPublisher(publisherData, playerData, 'wss -> wss');
    } finally {
      await pubContext.close();
      await playContext.close();
    }
  });

  test('wss publish to WHEP play: every received frame carries the marker', async ({ browser }) => {
    test.setTimeout(150_000);
    const pubContext = await newInstrumentedContext(browser);
    const playContext = await newInstrumentedContext(browser);
    const publisher = await pubContext.newPage();
    const viewer = await playContext.newPage();

    try {
      const streamName = uniqueStream('seiwhep');
      await publishStamped(publisher, { streamName });
      await playStamped(viewer, { streamName, useWhep: true });
      await joinPresentedFrames(viewer, '#player-video');
      await viewer.waitForTimeout(10_000);

      const stats = await inboundVideoStats(viewer);
      const publisherData = await readInstrument(publisher);
      const playerData = await readInstrument(viewer);
      summarize('wss -> WHEP, publisher', publisherData);
      const read = summarize('wss -> WHEP, player', playerData);
      console.log(`inbound stats: ${JSON.stringify(stats)}`);

      expect(stats?.mimeType, 'the session has to be H.264 for an SEI to exist').toMatch(/H264/i);
      expect(read.framesReceived, 'no encoded frames reached the WHEP player').toBeGreaterThan(30);
      expect(read.markerRate).toBe(1);
      expectStampsFromPublisher(publisherData, playerData, 'wss -> WHEP');
    } finally {
      await pubContext.close();
      await playContext.close();
    }
  });

  test('the probe off produces no marker at all', async ({ browser }) => {
    test.setTimeout(150_000);
    // stamp:false leaves the transforms attached and counting, so a 0% marker rate here is
    // evidence the reader is running and finding nothing, not evidence that it never ran.
    const pubContext = await newInstrumentedContext(browser, { stamp: false });
    const playContext = await newInstrumentedContext(browser, { stamp: false });
    const publisher = await pubContext.newPage();
    const viewer = await playContext.newPage();

    try {
      const streamName = uniqueStream('seioff');
      await publishStamped(publisher, { streamName });
      await playStamped(viewer, { streamName });
      await viewer.waitForTimeout(8_000);

      const read = summarize('probe off, player', await readInstrument(viewer));
      expect(read.framesReceived, 'the reader never saw a frame, so this proves nothing')
        .toBeGreaterThan(30);
      expect(read.framesStamped).toBe(0);
      expect(read.markerRate).toBe(0);
    } finally {
      await pubContext.close();
      await playContext.close();
    }
  });
});

/* ========================================================== the open question ============= */

// A pixel stamp was 8.7% readable on a rescaled simulcast rung. This checks whether the SEI
// survives the rungs.
test.describe('the open question: does the marker survive the simulcast rungs', () => {
  /*
   * Only rungs the browser actually encodes are measured. Against the fake 640x480 camera,
   * Chromium sends 0 frames for rung l while the Engine still lists <name>_l, so rungs with
   * framesSent 0 are skipped with a named reason.
   */
  const outboundRungs = (page) =>
    page.evaluate(async () => {
      for (const pc of window.__wz.pcs) {
        const report = await pc.getStats();
        const rows = [];
        report.forEach((entry) => {
          if (entry.type === 'outbound-rtp' && entry.kind === 'video') {
            rows.push({
              rid: entry.rid ?? null,
              ssrc: String(entry.ssrc),
              active: entry.active ?? null,
              framesSent: entry.framesSent ?? 0,
              frameWidth: entry.frameWidth ?? null,
              frameHeight: entry.frameHeight ?? null,
              qualityLimitationReason: entry.qualityLimitationReason ?? null,
            });
          }
        });
        if (rows.length) return rows;
      }
      return [];
    });

  // One rung at a time, each viewer closed before the next: two viewers on two rungs of one
  // simulcast ingest at once is unreliable on this Engine even with nothing injected.
  const runRungs = async (browser, { stamp }) => {
    const pubContext = await newInstrumentedContext(browser, { stamp });
    const publisher = await pubContext.newPage();
    const result = { stamp, publisher: null, outbound: [], rungs: {}, skipped: {} };

    try {
      const streamName = uniqueStream(stamp ? 'simOn' : 'simOff');
      await publishStamped(publisher, { streamName, simulcast: true });
      // Long enough for the encoder to have settled on which rungs it is going to fill.
      await publisher.waitForTimeout(15_000);
      result.outbound = await outboundRungs(publisher);
      // What the camera captures, which the top rung carries unscaled.
      result.sourceWidth = await publisher.evaluate(() => {
        for (const pc of window.__wz.pcs) {
          const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
          if (sender) return sender.track.getSettings().width ?? null;
        }
        return null;
      });
      console.log(`\npublisher outbound rungs, stamp=${stamp}:\n${JSON.stringify(result.outbound, null, 2)}`);

      // "h" is the source stream itself, so only the rescaled rungs have a <name>_<rid>.
      for (const row of result.outbound) {
        if (row.rid === null || row.rid === 'h') continue;
        if (row.framesSent === 0) {
          result.skipped[row.rid] = `the browser encoded 0 frames for rung ${row.rid} `
            + `(active=${row.active}, qualityLimitationReason=${row.qualityLimitationReason})`;
          continue;
        }
        const context = await newInstrumentedContext(browser, { stamp });
        const viewer = await context.newPage();
        try {
          await waitForRendition(viewer, streamName, row.rid);
          await joinPresentedFrames(viewer, '#player-video');
          await viewer.waitForTimeout(10_000);
          const raw = await readInstrument(viewer);
          const read = summarize(`simulcast rung _${row.rid}, stamp=${stamp}`, raw);
          const inbound = await inboundVideoStats(viewer);
          console.log(`_${row.rid} inbound: ${JSON.stringify(inbound)}`);
          result.rungs[row.rid] = { played: true, read, raw, inbound };
        } catch (error) {
          result.rungs[row.rid] = { played: false, error: error.message.split('\n')[0] };
        } finally {
          await context.close();
        }
      }

      result.publisherRaw = await readInstrument(publisher);
      result.publisher = summarize(`simulcast publisher, stamp=${stamp}`, result.publisherRaw);
      console.log(`rungs skipped, stamp=${stamp}: ${JSON.stringify(result.skipped)}`);
      return result;
    } finally {
      await pubContext.close();
    }
  };

  test('the control: a rescaled rung plays when nothing is injected', async ({ browser }) => {
    test.setTimeout(300_000);
    const control = await runRungs(browser, { stamp: false });
    const measuredRungs = Object.keys(control.rungs);

    // If a rescaled rung does not play with nothing injected, the harness or the Engine is
    // the problem, and the measurement below would blame the stamp for it.
    expect(measuredRungs.length,
      `no rescaled rung carried frames to measure. Skipped: ${JSON.stringify(control.skipped)}`)
      .toBeGreaterThan(0);
    for (const rung of measuredRungs) {
      expect(control.rungs[rung].played,
        `rung _${rung} did not play with no stamp: ${control.rungs[rung].error}`).toBe(true);
      expect(control.rungs[rung].read.framesStamped,
        'a control run must carry no marker').toBe(0);
    }
  });

  test('the measurement: count marker hits on every rung the browser fills', async ({ browser }) => {
    test.setTimeout(300_000);
    const measured = await runRungs(browser, { stamp: true });

    // More than one SSRC key proves simulcast ran, not a fallback to a single encoding.
    expect(Object.keys(measured.publisher.sentByRung).length,
      `simulcast was not active: ${JSON.stringify(measured.publisher.sentByRung)}`)
      .toBeGreaterThanOrEqual(2);
    // And the stamps carried more than rung 0, so a nonzero rung byte is on the wire.
    const rungIndices = new Set(measured.publisherRaw.sentStamps.map((s) => s.rungIndex));
    expect(Math.max(...rungIndices), 'every stamp carried rung 0').toBeGreaterThan(0);

    // Informational. If rid ever appears, the probe could key on it, which survives a
    // renegotiation where an SSRC may not.
    console.log(`rid populated on any sender frame: ${measured.publisher.ridSeen}`);

    const measuredRungs = Object.keys(measured.rungs);
    expect(measuredRungs.length,
      `no rescaled rung carried frames to measure. Skipped: ${JSON.stringify(measured.skipped)}`)
      .toBeGreaterThan(0);
    expect(measured.sourceWidth, 'the published video track reported no capture width')
      .toBeGreaterThan(0);

    for (const rung of measuredRungs) {
      const outcome = measured.rungs[rung];
      expect(outcome.played,
        `rung _${rung} never played with the stamp injected although the control plays it, `
        + `which is the stamp breaking the Engine's rung republish: ${outcome.error}`).toBe(true);
      expect(outcome.read.framesReceived, `rung _${rung} delivered no frames`).toBeGreaterThan(30);
      expect(outcome.read.markerRate, `the marker did not survive rung _${rung}`).toBe(1);
      // The join is on rung as well as sequence, so this is also the rung byte surviving.
      const joined = expectStampsFromPublisher(measured.publisherRaw, outcome.raw, `rung _${rung}`);
      console.log(`rung _${rung}: stamp rung values seen ${JSON.stringify(joined.rungs)}`);
      // Against the capture, not a fixed width: the Default capture size is the camera's call.
      expect(outcome.inbound.frameWidth,
        `rung _${rung} was not rescaled from the ${measured.sourceWidth} px capture, so it `
        + 'does not test what killed the pixel stamp')
        .toBeLessThan(measured.sourceWidth);
    }
  });
});

/* ============================================================ does no harm ================ */

test.describe('injection does no harm', () => {
  /*
   * Two baseline and two stamped sessions. framesDropped, pliCount, packetsLost and decoded
   * resolution move when a decoder cannot parse a frame, so they must match. freezeCount moves
   * on its own (compositor scheduling, startup), so it is bounded by the baseline's spread.
   */
  test('the decoder counters match a baseline run', async ({ browser }) => {
    test.setTimeout(400_000);
    const measure = async (stamp, run) => {
      const pubContext = await newInstrumentedContext(browser, { stamp });
      const playContext = await newInstrumentedContext(browser, { stamp });
      const publisher = await pubContext.newPage();
      const viewer = await playContext.newPage();
      try {
        const streamName = uniqueStream(stamp ? `harmOn${run}` : `harmOff${run}`);
        await publishStamped(publisher, { streamName });
        await playStamped(viewer, { streamName });
        await viewer.waitForTimeout(12_000);
        const read = await readInstrument(viewer);
        const stats = await inboundVideoStats(viewer);
        const label = `${stamp ? 'stamped' : 'baseline'} run ${run}`;
        summarize(label, read);
        console.log(`${label} inbound: ${JSON.stringify(stats)}`);
        return { label, stats, read };
      } finally {
        await pubContext.close();
        await playContext.close();
      }
    };

    const baselines = [await measure(false, 1), await measure(false, 2)];
    const stampeds = [await measure(true, 1), await measure(true, 2)];
    const all = [...baselines, ...stampeds];

    for (const arm of all) {
      expect(arm.stats, `${arm.label} produced no inbound video stats`).not.toBeNull();
    }
    // The marker has to actually be in the stamped arms, or this test compares nothing.
    for (const arm of stampeds) {
      expect(arm.read.frames.filter((f) => f.seq !== null).length,
        `${arm.label} carried no marker`).toBeGreaterThan(30);
    }
    for (const arm of baselines) {
      expect(arm.read.frames.filter((f) => f.seq !== null).length,
        `${arm.label} is a baseline and must carry no marker`).toBe(0);
    }

    const values = (arms, field) => arms.map((a) => a.stats[field]);
    const report = {
      framesDropped: { baseline: values(baselines, 'framesDropped'), stamped: values(stampeds, 'framesDropped') },
      pliCount: { baseline: values(baselines, 'pliCount'), stamped: values(stampeds, 'pliCount') },
      nackCount: { baseline: values(baselines, 'nackCount'), stamped: values(stampeds, 'nackCount') },
      packetsLost: { baseline: values(baselines, 'packetsLost'), stamped: values(stampeds, 'packetsLost') },
      freezeCount: { baseline: values(baselines, 'freezeCount'), stamped: values(stampeds, 'freezeCount') },
      resolution: all.map((a) => `${a.stats.frameWidth}x${a.stats.frameHeight}`),
      framesDecoded: all.map((a) => a.stats.framesDecoded),
    };
    console.log(`\n--- does no harm, four sessions ---\n${JSON.stringify(report, null, 2)}`);

    // The parse-failure counters, asserted equal across every session.
    for (const field of ['framesDropped', 'pliCount', 'packetsLost']) {
      const baselineMax = Math.max(...values(baselines, field));
      for (const arm of stampeds) {
        expect(arm.stats[field],
          `${field} moved with the stamp: baseline ${JSON.stringify(values(baselines, field))}, `
          + `${arm.label} ${arm.stats[field]}`).toBe(baselineMax);
      }
    }

    // A decoder that could not parse the stream would not hold the same resolution.
    const resolutions = new Set(report.resolution);
    expect([...resolutions],
      `the decoded resolution differed across sessions: ${JSON.stringify(report.resolution)}`)
      .toHaveLength(1);

    // Allowance: baseline max plus its spread plus one. Two baselines give only a floor on the
    // real noise, hence the plus one.
    const baselineSpread = Math.max(...values(baselines, 'freezeCount'))
      - Math.min(...values(baselines, 'freezeCount'));
    const allowance = Math.max(...values(baselines, 'freezeCount')) + baselineSpread + 1;
    for (const arm of stampeds) {
      expect(arm.stats.freezeCount,
        `${arm.label} froze ${arm.stats.freezeCount} times against baselines `
        + `${JSON.stringify(values(baselines, 'freezeCount'))}, past the allowance of ${allowance}`)
        .toBeLessThanOrEqual(allowance);
    }
  });
});

/* ====================================================== join to presented frames ========== */

test.describe('encoded frames join to presented frames', () => {
  test('every presented frame matches an encoded frame on rtpTimestamp', async ({ browser }) => {
    test.setTimeout(150_000);
    const pubContext = await newInstrumentedContext(browser);
    const playContext = await newInstrumentedContext(browser);
    const publisher = await pubContext.newPage();
    const viewer = await playContext.newPage();

    try {
      const streamName = uniqueStream('join');
      await publishStamped(publisher, { streamName });
      await playStamped(viewer, { streamName });
      // The join starts after PLAYING, so presented frames are only counted from a point
      // where every encoded frame they could match is already recorded.
      await joinPresentedFrames(viewer, '#player-video');
      await viewer.waitForTimeout(12_000);

      const read = await readInstrument(viewer);
      const summary = summarize('rtpTimestamp join', read);
      const withDisplay = read.frames.filter((f) => f.displayHi !== null).length;
      console.log(`encoded records that got a display time: ${withDisplay} of ${read.frames.length}`);

      expect(summary.presented, 'requestVideoFrameCallback never fired').toBeGreaterThan(30);
      expect(read.presentedWithRtp, 'rVFC metadata carried no rtpTimestamp, so no join is possible')
        .toBe(summary.presented);
      expect(read.presentedWithExpected, 'rVFC metadata carried no expectedDisplayTime')
        .toBe(summary.presented);
      expect(summary.joinRate).toBe(1);
      // A join that produced no player-side figure is a join in name only.
      expect(summary.playerP50).not.toBeNull();
    } finally {
      await pubContext.close();
      await playContext.close();
    }
  });
});

/* ============================================================ a stalled publisher ========= */

test.describe('a stalled publisher produces missed frames, not a wrong number', () => {
  /*
   * Two stalls. Loss: frames go missing and the sequence shows it (manufactured, since loopback
   * loses nothing). Silence: the publisher's thread blocks and nothing is sent, so the signal
   * is the age of the last frame.
   */
  test('dropped frames are counted as missed, and the count matches what was dropped', async ({ browser }) => {
    test.setTimeout(150_000);
    const dropEvery = 10;
    const pubContext = await newInstrumentedContext(browser, { dropEvery });
    const playContext = await newInstrumentedContext(browser);
    const publisher = await pubContext.newPage();
    const viewer = await playContext.newPage();

    try {
      const streamName = uniqueStream('drop');
      await publishStamped(publisher, { streamName });
      await playStamped(viewer, { streamName });
      await viewer.waitForTimeout(12_000);

      const sent = summarize('every 10th frame dropped, publisher', await readInstrument(publisher));
      const read = summarize('every 10th frame dropped, player', await readInstrument(viewer));

      expect(sent.sentDropped, 'nothing was dropped, so there is nothing to detect')
        .toBeGreaterThan(3);
      expect(read.framesStamped, 'the player read no stamped frames').toBeGreaterThan(30);
      expect(read.missedFrames, 'the player saw no gaps although frames were dropped')
        .toBeGreaterThan(0);
      // Roughly the injected loss rate, not merely non-zero. Wide bounds, because the two
      // windows do not start and end on the same frame.
      const lossRatio = read.missedFrames / (read.framesStamped + read.missedFrames);
      console.log(`measured loss ratio: ${lossRatio} against an injected 1 in ${dropEvery}`);
      expect(lossRatio).toBeGreaterThan(0.03);
      expect(lossRatio).toBeLessThan(0.25);
    } finally {
      await pubContext.close();
      await playContext.close();
    }
  });

  test('a blocked publisher thread produces a measurable silence, not a fresh figure', async ({ browser }) => {
    test.setTimeout(180_000);
    const pubContext = await newInstrumentedContext(browser);
    const playContext = await newInstrumentedContext(browser);
    const publisher = await pubContext.newPage();
    const viewer = await playContext.newPage();

    try {
      const streamName = uniqueStream('stall');
      await publishStamped(publisher, { streamName });
      await playStamped(viewer, { streamName });
      await viewer.waitForTimeout(6_000);

      const before = await readInstrument(viewer);
      const blockMs = 4_000;
      // A synchronous busy loop stalls the publisher's main thread, sender transform included.
      await publisher.evaluate((ms) => {
        const until = Date.now() + ms;
        while (Date.now() < until) { /* hold the thread */ }
      }, blockMs);
      const after = await readInstrument(viewer);

      const stampedBefore = before.frames.filter((f) => f.seq !== null);
      const stampedAfter = after.frames.filter((f) => f.seq !== null);
      const arrivals = stampedAfter.map((f) => f.arrivedAt);
      let biggestSilence = 0;
      for (let i = 1; i < arrivals.length; i += 1) {
        biggestSilence = Math.max(biggestSilence, arrivals[i] - arrivals[i - 1]);
      }
      /*
       * The newest frame's age is the signal, not the biggest arrival gap: nothing arrives
       * during the block, so the silence sits at the end of the record with no pair of
       * arrivals around it. This is what the design's STALE_MS rule reads.
       */
      const summary = summarize('blocked publisher, player', after);
      const newestAgeAtRead = Date.now() - (arrivals.length ? arrivals[arrivals.length - 1] : Date.now());
      const framesDuringBlock = stampedAfter.length - stampedBefore.length;

      console.log(`\n--- blocked publisher ---\n${JSON.stringify({
        blockMs,
        stampedBefore: stampedBefore.length,
        stampedAfter: stampedAfter.length,
        framesDuringBlock,
        biggestSilenceMs: biggestSilence,
        newestFrameAgeMs: newestAgeAtRead,
        missedFramesReported: summary.missedFrames,
        transportP50BeforeBlock: summary.transportP50,
      }, null, 2)}`);

      expect(stampedBefore.length, 'nothing was measured before the block').toBeGreaterThan(30);

      // Either the newest frame is older than STALE_MS (1,000 ms) or the publisher recovered
      // and left a gap that size. Neither means the block never reached the media path.
      expect(Math.max(newestAgeAtRead, biggestSilence),
        `neither a stale newest frame nor a gap: age ${newestAgeAtRead} ms, gap ${biggestSilence} ms`)
        .toBeGreaterThan(1_000);

      // At about 20 fps a 4 s block costs roughly 80 frames; near that many arriving means the
      // thread was not actually held.
      expect(framesDuringBlock,
        `${framesDuringBlock} stamped frames arrived during a ${blockMs} ms block, so the `
        + 'publisher was not actually stalled').toBeLessThan(20);

      // The figures now rest on pre-block frames; the last real median must still exist so the
      // probe can report it as stale rather than as a fresh reading.
      expect(stampedAfter.length, 'no stamped frame at all after the block').toBeGreaterThan(30);
      expect(summary.transportP50,
        'a stalled session still has to carry its last real measurement, not null')
        .not.toBeNull();
    } finally {
      await pubContext.close();
      await playContext.close();
    }
  });
});

/* =========================================== mode A against mode B ======================== */

test.describe('same-machine clock modes agree', () => {
  // Mode A: publisher and player in one JS context (the split view). Mode B: two contexts on
  // one machine. Both read the same OS clock, so the transport figures should agree.
  test('the split view and two contexts report the same transport leg', async ({ browser }) => {
    test.setTimeout(240_000);

    const modeA = await (async () => {
      const context = await newInstrumentedContext(browser);
      const page = await context.newPage();
      try {
        const streamName = uniqueStream('modeA');
        await page.goto('/#/loopback');
        await requireEngine(page, test);
        await startPublishing(page, { streamName, codec: 'H264' });
        await expectLive(page);
        await page.getByRole('button', { name: 'Player', exact: true }).click();
        await fillPlayForm(page, { streamName });
        await playWithRetry(page);
        await joinPresentedFrames(page, '#player-video');
        await page.waitForTimeout(12_000);
        return summarize('mode A, split view, one context', await readInstrument(page));
      } finally {
        await context.close();
      }
    })();

    const modeB = await (async () => {
      const pubContext = await newInstrumentedContext(browser);
      const playContext = await newInstrumentedContext(browser);
      const publisher = await pubContext.newPage();
      const viewer = await playContext.newPage();
      try {
        const streamName = uniqueStream('modeB');
        await publishStamped(publisher, { streamName });
        await playStamped(viewer, { streamName });
        await joinPresentedFrames(viewer, '#player-video');
        await viewer.waitForTimeout(12_000);
        return summarize('mode B, two contexts, one machine', await readInstrument(viewer));
      } finally {
        await pubContext.close();
        await playContext.close();
      }
    })();

    expect(modeA.markerRate, 'the split view read no marker').toBe(1);
    expect(modeB.markerRate, 'the two-context run read no marker').toBe(1);
    expect(modeA.transportP50).not.toBeNull();
    expect(modeB.transportP50).not.toBeNull();

    const difference = Math.abs(modeA.transportP50 - modeB.transportP50);
    console.log(`\nmode A p50 ${modeA.transportP50} ms, mode B p50 ${modeB.transportP50} ms, `
      + `difference ${difference} ms`);

    // A tolerance on session-to-session jitter buffer variation; clock error is zero in both
    // arms. A systematic clock difference between the modes would exceed it.
    expect(difference).toBeLessThan(40);
  });
});

/* ========================================== the feature, when it is in the build ========== */

// These test the feature (toggle, panel, wiring) rather than the instrument, and skip with a
// named reason when the probe is not in the build.
const requireProbeUi = async (page, testRef) => {
  await page.goto('/#/play');
  const present = await page.locator('#playLatencyProbe').count();
  testRef.skip(present === 0,
    'The Latency Probe toggle is not in this build. src/diagnostics/latencyProbe.js and '
    + 'src/components/diagnostics/LatencyGroup.jsx have to be placed and the pages wired '
    + 'before these can run.');
};

test.describe('the latency probe feature', () => {
  test('the probe off renders no latency group', async ({ page }) => {
    await requireProbeUi(page, test);
    await requireEngine(page, test);
    const streamName = uniqueStream('uioff');

    await page.goto('/#/loopback');
    await startPublishing(page, { streamName, codec: 'H264' });
    await expectLive(page);
    await page.getByRole('button', { name: 'Player', exact: true }).click();
    await fillPlayForm(page, { streamName });
    await playWithRetry(page);
    await page.waitForTimeout(4_000);

    await expect(page.locator('#latency-group')).toHaveCount(0);
  });

  test('with the probe on at both ends the panel reports a figure', async ({ page }) => {
    test.setTimeout(150_000);
    await requireProbeUi(page, test);
    await requireEngine(page, test);
    const streamName = uniqueStream('uion');

    await page.goto('/#/loopback');
    await waitForCamera(page);
    await openTab(page, 'Advanced');
    await page.locator('#publishLatencyProbe').check();
    await openTab(page, 'Connection');
    await startPublishing(page, { streamName, codec: 'H264' });
    await expectLive(page);

    await page.getByRole('button', { name: 'Player', exact: true }).click();
    await openTab(page, 'Advanced');
    await page.locator('#playLatencyProbe').check();
    await openTab(page, 'Connection');
    await fillPlayForm(page, { streamName });
    await playWithRetry(page);

    const group = page.locator('#latency-group');
    await expect(group).toBeVisible({ timeout: 20_000 });
    // Both arms are in one JS context, so the clock is the same one and the panel has to say
    // so rather than quote an uncertainty it does not have.
    await expect(group).toContainText(/exact/i, { timeout: 30_000 });
    await expect(group).toContainText(/\d+\s*ms/, { timeout: 30_000 });
    console.log(`latency panel text:\n${await group.innerText()}`);
  });
});

// A stopped session must release its timers, its emit interval, the connection and the
// publisher's "stamping" flag.
test.describe('a stopped session lets go', () => {

  const countTimers = (page) => page.evaluate(() => ({
    timeouts: window.__wzTimers.timeouts.size,
    intervals: window.__wzTimers.intervals.size,
  }));

  const watchTimers = (page) => page.addInitScript(() => {
    window.__wzTimers = { timeouts: new Set(), intervals: new Set() };
    const { setTimeout: st, clearTimeout: ct, setInterval: si, clearInterval: ci } = window;
    window.setTimeout = (...a) => {
      const id = st(...a);
      window.__wzTimers.timeouts.add(id);
      return id;
    };
    window.clearTimeout = (id) => { window.__wzTimers.timeouts.delete(id); return ct(id); };
    window.setInterval = (...a) => {
      const id = si(...a);
      window.__wzTimers.intervals.add(id);
      return id;
    };
    window.clearInterval = (id) => { window.__wzTimers.intervals.delete(id); return ci(id); };
  });

  test('the probe stops emitting and stops holding the connection', async ({ browser }) => {
    const publisher = await browser.newPage();
    await publisher.goto('/#/publish');
    await requireEngine(publisher, test);

    const streamName = uniqueStream('letgo');
    await waitForCamera(publisher);
    await openTab(publisher, 'Advanced');
    await publisher.locator('#publishLatencyProbe').check();
    await openTab(publisher, 'Connection');
    await startPublishing(publisher, { streamName });
    await expectLive(publisher);

    const viewer = await browser.newPage();
    await watchTimers(viewer);
    await viewer.goto('/#/play');
    await openTab(viewer, 'Advanced');
    await viewer.locator('#playLatencyProbe').check();
    await openTab(viewer, 'Connection');
    await startPlaying(viewer, { streamName });
    await expectPlaying(viewer);
    await viewer.waitForTimeout(3000);

    const running = await countTimers(viewer);
    expect(running.intervals, 'the probe should be emitting while it plays')
      .toBeGreaterThan(0);

    await viewer.locator('#play-toggle').click();
    await viewer.waitForTimeout(2000);

    const stopped = await countTimers(viewer);
    expect(stopped.intervals, 'the probe kept its emit interval after the stop')
      .toBeLessThan(running.intervals);


    await publisher.close();
    await viewer.close();
  });

  /*
   * A page that has stamped before must not claim one context for somebody else's stream. The
   * claim now rests on the frames being this page's own, not on a stamping flag, and this pins
   * that: the page publishes, stops, and plays another page's stream without a reload, which
   * would reset the module state and pass for the wrong reason.
   */
  test('a stopped publisher does not make the next playback claim one clock', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/#/publish');
    await requireEngine(page, test);

    // Publish with the probe, then stop.
    await waitForCamera(page);
    await openTab(page, 'Advanced');
    await page.locator('#publishLatencyProbe').check();
    await openTab(page, 'Connection');
    await startPublishing(page, { streamName: uniqueStream('stale') });
    await expectLive(page);
    await page.waitForTimeout(1500);
    await page.locator('#publish-toggle').click();
    await expect(page.locator('#video-live-indicator-live')).toBeHidden();

    // Somebody else's stream, from its own page, so the frames carry another context's clock.
    const other = await browser.newPage();
    await other.goto('/#/publish');
    const theirStream = uniqueStream('theirs');
    await waitForCamera(other);
    await openTab(other, 'Advanced');
    await other.locator('#publishLatencyProbe').check();
    await openTab(other, 'Connection');
    await startPublishing(other, { streamName: theirStream });
    await expectLive(other);

    // Same page, no reload: the hash route keeps the module state the flag lives in.
    await page.getByRole('link', { name: 'Play', exact: true }).click();
    await openTab(page, 'Advanced');
    await page.locator('#playLatencyProbe').check();
    await openTab(page, 'Connection');
    await startPlaying(page, { streamName: theirStream });
    await expectPlaying(page);
    await page.waitForTimeout(4000);

    const clockRow = page.locator('.wz-latency__table tr').filter({ hasText: 'Clock' }).first();
    // The frames are another page's, so "this page's own stream" is the one wrong reading. What
    // is right depends on the round trip: exact (one clock) against a local Engine, an estimate
    // with its bound, or a refusal, further away.
    await expect(clockRow).toContainText(/exact \(one clock\)|\u00b1|syncing|too uncertain/,
      { timeout: 15_000 });
    await expect(clockRow, 'a stale stamping flag claimed this page\'s own stream')
      .not.toContainText("this page's own stream");

    await other.close();
    await context.close();
  });
});

// The time drawn onto every frame before encode, replacing the published video track.
test.describe('burned-in clock', () => {

  // Which track the preview shows: the derived one is a MediaStreamTrackGenerator.
  const previewTrack = (page) => page.evaluate(() => {
    const stream = document.getElementById('publisher-video')?.srcObject;
    const track = stream && stream.getVideoTracks()[0];
    if (!track) return null;
    return {
      readyState: track.readyState,
      derived: typeof MediaStreamTrackGenerator === 'function'
        && track instanceof MediaStreamTrackGenerator,
    };
  });

  /*
   * The top-left corner of the preview, inside the clock's black plate and clear of its text
   * (the text starts one padding in). Average luma 0-255 and a checksum of the pixels.
   */
  const corner = (page) => page.evaluate(() => {
    const video = document.getElementById('publisher-video');
    if (!video || !video.videoWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0);
    const size = 6;
    const { data } = ctx.getImageData(0, 0, size, size);
    let luma = 0;
    for (let i = 0; i < data.length; i += 4) {
      luma += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    /*
     * The clock's digits, which change every frame. The plate scales with the frame height, so
     * a fixed 200 px box reaches only the seconds at 1280x720 and 300 ms usually shows no
     * change: find the plate's edges (where the black ends along its top row and left column)
     * and sum everything inside it, milliseconds included.
     */
    const dark = (x, y) => {
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
      return 0.299 * r + 0.587 * g + 0.114 * b < 40;
    };
    let plateWidth = 0;
    while (plateWidth < canvas.width && dark(plateWidth, 1)) plateWidth += 1;
    let plateHeight = 0;
    while (plateHeight < canvas.height && dark(1, plateHeight)) plateHeight += 1;
    const text = ctx.getImageData(0, 0, Math.max(plateWidth, 1), Math.max(plateHeight, 1)).data;
    let sum = 0;
    for (let i = 0; i < text.length; i += 4) sum = (sum * 31 + text[i]) % 1_000_003;
    return { luma: luma / (size * size), textSum: sum, plate: `${plateWidth}x${plateHeight}` };
  });

  const hookConnections = (page) => page.addInitScript(() => {
    const Original = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = class extends Original {
      constructor(...args) { super(...args); window.__pcs.push(this); }
    };
  });

  const videoSent = (page) => page.evaluate(async () => {
    let out = null;
    for (const pc of window.__pcs || []) {
      (await pc.getStats()).forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'video') {
          out = { framesEncoded: r.framesEncoded ?? 0, bytesSent: r.bytesSent ?? 0 };
        }
      });
    }
    return out;
  });

  test('keeps publishing video, and goes on publishing it', async ({ page }) => {
    await hookConnections(page);
    await requireEngine(page, test);
    await page.goto('/#/publish');
    await waitForCamera(page);

    await openTab(page, 'Advanced');
    await page.locator('#publishBurnedClock').check();
    await openTab(page, 'Connection');
    await startPublishing(page, { streamName: uniqueStream('burned') });
    await expectLive(page);
    await page.waitForTimeout(3000);

    const first = await videoSent(page);
    expect(first, 'no outbound video at all').not.toBeNull();
    expect(first.framesEncoded, 'the clock stopped the video').toBeGreaterThan(20);

    // Still going a few seconds later, rather than having stalled after a handful of frames.
    await page.waitForTimeout(3000);
    const second = await videoSent(page);
    expect(second.framesEncoded).toBeGreaterThan(first.framesEncoded + 20);
  });

  test('draws it on the preview, so both ends can be photographed together', async ({ page }) => {
    await page.goto('/#/publish');
    await waitForCamera(page);
    await openTab(page, 'Advanced');
    const before = await corner(page);
    await page.locator('#publishBurnedClock').check();

    // The preview carries the derived track, not the raw camera.
    await expect.poll(() => previewTrack(page), { timeout: 10_000 })
      .toEqual({ readyState: 'live', derived: true });

    // And the pixels are the clock's: a black plate in the corner, digits that keep moving.
    await expect.poll(async () => (await corner(page))?.luma ?? 255, { timeout: 10_000 })
      .toBeLessThan(40);
    const first = await corner(page);
    await page.waitForTimeout(300);
    const later = await corner(page);
    console.log(`corner before the clock ${JSON.stringify(before)}, with it ${JSON.stringify(first)}`);
    expect(later.textSum, 'the digits did not change in 300 ms').not.toBe(first.textSum);
  });

  /*
   * Switching sides on the combined page unmounts the settings form while the publish carries
   * on, so the derived track cannot belong to that component's lifetime.
   */
  test('survives the settings form being unmounted', async ({ page }) => {
    await hookConnections(page);
    await requireEngine(page, test);
    await page.goto('/#/loopback');
    await waitForCamera(page);

    await openTab(page, 'Advanced');
    await page.locator('#publishBurnedClock').check();
    await openTab(page, 'Connection');
    await page.fill('#signalingURL', SIGNALING_URL);
    await page.fill('#applicationName', APPLICATION);
    await page.fill('#streamName', uniqueStream('burnedSwap'));
    await page.click('#publish-toggle');
    await expectLive(page);
    await page.waitForTimeout(2000);

    const before = await videoSent(page);
    await page.getByRole('button', { name: 'Player', exact: true }).click();
    await page.getByRole('button', { name: 'Publisher', exact: true }).click();
    await page.waitForTimeout(3000);

    const after = await videoSent(page);
    expect(after.framesEncoded, 'the side switch stopped the video')
      .toBeGreaterThan(before.framesEncoded + 20);
  });

  // Camera off, clock on, camera on: the camera under the clock has to come back too.
  test('the camera toggle switches the camera under the clock', async ({ page }) => {
    const tracks = () => page.evaluate(() => {
      const track = document.getElementById('publisher-video')?.srcObject?.getVideoTracks()[0];
      const camera = track && track.__wzClockSource;
      return track ? { published: track.enabled, camera: camera ? camera.enabled : null } : null;
    });

    await page.goto('/#/publish');
    await waitForCamera(page);
    await openTab(page, 'Source');
    await page.locator('#camera-toggle').click();
    await openTab(page, 'Advanced');
    await page.locator('#publishBurnedClock').check();

    // Off: both the derived track and the camera behind it.
    await expect.poll(tracks, { timeout: 10_000 }).toEqual({ published: false, camera: false });

    await openTab(page, 'Source');
    await page.locator('#camera-toggle').click();
    await expect.poll(tracks, { timeout: 10_000 }).toEqual({ published: true, camera: true });
  });

  test('turning it off puts the camera back', async ({ page }) => {
    await page.goto('/#/publish');
    await waitForCamera(page);
    await openTab(page, 'Advanced');

    await page.locator('#publishBurnedClock').check();
    await expect.poll(() => previewTrack(page), { timeout: 10_000 })
      .toEqual({ readyState: 'live', derived: true });
    await page.locator('#publishBurnedClock').uncheck();

    // The camera itself, live, not the derived track and not a stopped one.
    await expect.poll(() => previewTrack(page), { timeout: 10_000 })
      .toEqual({ readyState: 'live', derived: false });
  });
});

test.describe('how these numbers are measured', () => {

  const openPanel = async (page) => {
    await requireEngine(page, test);
    await page.goto('/#/loopback');
    await waitForCamera(page);

    const streamName = uniqueStream('help');
    await openTab(page, 'Advanced');
    await page.locator('#publishLatencyProbe').check();
    await openTab(page, 'Connection');
    await page.fill('#signalingURL', SIGNALING_URL);
    await page.fill('#applicationName', APPLICATION);
    await page.fill('#streamName', streamName);
    await page.click('#publish-toggle');
    await expectLive(page);

    await page.getByRole('button', { name: 'Player', exact: true }).click();
    await openTab(page, 'Advanced');
    await page.locator('#playLatencyProbe').check();
    await openTab(page, 'Connection');
    await page.fill('#playSignalingURL', SIGNALING_URL);
    await page.fill('#playApplicationName', APPLICATION);
    await page.fill('#playStreamName', streamName);
    await page.click('#play-toggle');
    await expectPlaying(page);
  };

  test('opens from the panel head and closes every way it should', async ({ page }) => {
    await openPanel(page);

    const dialog = page.locator('#measurement-help');
    await expect(dialog).toBeHidden();

    await page.locator('#measurement-help-open').click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('do not add up');
    // Named, so a screen reader announces what opened; the opener says what it opens.
    await expect(page.getByRole('dialog', { name: 'How these numbers are measured' })).toBeVisible();
    await expect(page.locator('#measurement-help-open'))
      .toHaveAccessibleName(/how the latency figures are measured/i);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.locator('#measurement-help-open').click();
    await page.locator('#measurement-help-close').click();
    await expect(dialog).toBeHidden();
  });

  test('answers the three questions it exists for', async ({ page }) => {
    await openPanel(page);
    await page.locator('#measurement-help-open').click();
    const dialog = page.locator('#measurement-help');

    // Why a round trip is not the delay a frame experiences.
    await expect(dialog).toContainText('Round trip is not latency');
    // Why the player's estimate is smaller than the probe.
    await expect(dialog).toContainText('Latency covers the last hop only');
    // Why a packet loss figure of zero on one side is an answer, not a missing reading.
    await expect(dialog).toContainText('Packet loss is per direction');
  });

  // The sentence that has to survive on the panel itself, because it qualifies every figure.
  test('leaves the short caveat on the panel', async ({ page }) => {
    await openPanel(page);
    await expect(page.locator('.wz-latency__caveat'))
      .toContainText('larger than this');
  });

  /*
   * Playwright's default color scheme is light and the app follows the system, so the dark pass
   * has to ask for dark. Checked on the title and on the body text, which uses the muted and
   * subtle tokens: 7:1 for the title, 4.5:1 (WCAG AA) for body text.
   */
  test('is readable in both themes', async ({ page }) => {
    const contrast = (selector) => page.evaluate((sel) => {
      const luminance = (colour) => {
        const [r, g, b] = colour.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const element = document.querySelector(sel);
      const text = luminance(getComputedStyle(element).color);
      const behind = luminance(getComputedStyle(document.getElementById('measurement-help')).backgroundColor);
      return (Math.max(text, behind) + 0.05) / (Math.min(text, behind) + 0.05);
    }, selector);

    const check = async (theme) => {
      await expect(page.locator('html')).toHaveAttribute('data-bs-theme', theme);
      await page.locator('#measurement-help-open').click();
      expect(await contrast('#measurement-help'), `${theme}: dialog text`).toBeGreaterThan(7);
      expect(await contrast('#measurement-help-title'), `${theme}: title`).toBeGreaterThan(7);
      // --wz-text-muted
      expect(await contrast('#measurement-help .wz-help__body p'), `${theme}: body text`)
        .toBeGreaterThan(4.5);
      // --wz-text-subtle
      expect(await contrast('#measurement-help .wz-help__body h3'), `${theme}: headings`)
        .toBeGreaterThan(4.5);
    };

    await page.emulateMedia({ colorScheme: 'dark' });
    await openPanel(page);
    await check('dark');

    await page.evaluate(() => window.localStorage.setItem('wz.theme', 'light'));
    await page.reload();
    await openPanel(page);
    await check('light');
  });
});

// Both ends share one Date.now, so the offset is exact even though the clock samples' round
// trip to the Engine exceeds the trusted bound.
test.describe('the combined page clock', () => {

  test('measures a latency rather than refusing over the sample round trip', async ({ page }) => {
    await requireEngine(page, test);
    await page.goto('/#/loopback');
    await waitForCamera(page);

    const streamName = uniqueStream('loopClock');
    await openTab(page, 'Advanced');
    await page.locator('#publishLatencyProbe').check();
    await openTab(page, 'Connection');
    await page.fill('#signalingURL', SIGNALING_URL);
    await page.fill('#applicationName', APPLICATION);
    await page.fill('#streamName', streamName);
    await page.click('#publish-toggle');
    await expectLive(page);

    await page.getByRole('button', { name: 'Player', exact: true }).click();
    await openTab(page, 'Advanced');
    await page.locator('#playLatencyProbe').check();
    await openTab(page, 'Connection');
    await page.fill('#playSignalingURL', SIGNALING_URL);
    await page.fill('#playApplicationName', APPLICATION);
    await page.fill('#playStreamName', streamName);
    await page.click('#play-toggle');
    await expectPlaying(page);

    const rows = page.locator('.wz-latency__table tr');
    const row = (name) => rows.filter({ hasText: name }).first();

    await expect(row('Clock')).toContainText('exact', { timeout: 20_000 });
    await expect(row('Clock')).toContainText("this page's own stream");

    // And the figures are figures, not dashes, with no bound: the offset is zero by proof.
    for (const name of ['Publisher to player', 'Player jitter buffer', 'Total']) {
      await expect(row(name)).toContainText(/\d+\s*ms/, { timeout: 20_000 });
      await expect(row(name)).not.toContainText('\u00b1');
    }

    // ENG-5152: once two samples exist, the three measured rows carry a history graph to
    // the left of the number, and the two non-measured rows never do.
    for (const name of ['Publisher to player', 'Player jitter buffer', 'Total']) {
      await expect(row(name).locator('.wz-spark svg')).toBeVisible({ timeout: 20_000 });
    }
    for (const name of ['Clock', 'Frames missed']) {
      await expect(row(name).locator('.wz-spark')).toHaveCount(0);
    }
  });
});

test.describe('a stream that cannot carry a stamp', () => {

  test('the publisher says so before publishing, while Auto is selected', async ({ page }) => {
    await page.goto('/#/publish');
    await openTab(page, 'Advanced');

    // Nothing to say until the probe is actually on.
    await expect(page.locator('#publishLatencyProbe-codec-risk')).toHaveCount(0);

    await page.locator('#publishLatencyProbe').check();
    await expect(page.locator('#publishLatencyProbe-codec-risk')).toContainText('Auto');

    // Choosing H.264 settles it, so the warning goes.
    await openTab(page, 'Source');
    await page.selectOption('#videoCodec', 'H264');
    await openTab(page, 'Advanced');
    await expect(page.locator('#publishLatencyProbe-codec-risk')).toHaveCount(0);
  });

  test('the player names the codec instead of listing what it might be', async ({ browser }) => {
    const publisher = await browser.newPage();
    await publisher.goto('/#/publish');
    await requireEngine(publisher, test);

    const streamName = uniqueStream('vp8');
    await waitForCamera(publisher);
    await openTab(publisher, 'Source');
    await publisher.selectOption('#videoCodec', 'VP8');
    await openTab(publisher, 'Connection');
    await startPublishing(publisher, { streamName });
    await expectLive(publisher);

    const viewer = await browser.newPage();
    await viewer.goto('/#/play');
    await openTab(viewer, 'Advanced');
    await viewer.locator('#playLatencyProbe').check();
    await openTab(viewer, 'Connection');
    await startPlaying(viewer, { streamName });
    await expectPlaying(viewer);
    await viewer.waitForTimeout(3000);

    const panel = viewer.locator('.wz-latency__caveat');
    await expect(panel).toContainText('VP8');
    await expect(panel).toContainText('H.264 SEI NAL');
    await expect(panel).toContainText('Set Video Codec to H.264');

    await publisher.close();
    await viewer.close();
  });
});

// encodedInsertableStreams applies to the whole connection, so audio frames stop too unless
// script pipes them back.
test.describe('the probe and the rest of the media', () => {

  const hookConnections = (page) => page.addInitScript(() => {
    const Original = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = class extends Original {
      constructor(...args) { super(...args); window.__pcs.push(this); }
    };
  });

  const rtp = (page, type) => page.evaluate(async (wanted) => {
    const pc = (window.__pcs || []).filter((c) => c.connectionState === 'connected').pop();
    if (!pc) return null;
    let found = null;
    (await pc.getStats()).forEach((r) => {
      if (r.type === wanted && r.kind === 'audio') {
        found = { bytes: r.bytesSent ?? r.bytesReceived ?? 0,
                  packets: r.packetsSent ?? r.packetsReceived ?? 0 };
      }
    });
    return found;
  }, type);

  test('a publish with the probe on still sends audio', async ({ page }) => {
    await hookConnections(page);
    await requireEngine(page, test);
    await page.goto('/#/publish');
    await waitForCamera(page);
    await openTab(page, 'Advanced');
    await page.locator('#publishLatencyProbe').check();
    await openTab(page, 'Connection');
    await startPublishing(page, { streamName: uniqueStream('probeAudio') });
    await expectLive(page);
    await page.waitForTimeout(3000);

    const audio = await rtp(page, 'outbound-rtp');
    expect(audio, 'no outbound audio stream at all').not.toBeNull();
    expect(audio.packets, 'the probe stopped the audio going out').toBeGreaterThan(0);
    expect(audio.bytes).toBeGreaterThan(0);
  });

  test('a playback with the probe on still receives audio', async ({ browser }) => {
    const publisher = await browser.newPage();
    await publisher.goto('/#/publish');
    await requireEngine(publisher, test);
    const streamName = uniqueStream('probeAudioIn');
    await startPublishing(publisher, { streamName });
    await expectLive(publisher);

    const viewer = await browser.newPage();
    await hookConnections(viewer);
    await viewer.goto('/#/play');
    await openTab(viewer, 'Advanced');
    await viewer.locator('#playLatencyProbe').check();
    await openTab(viewer, 'Connection');
    await startPlaying(viewer, { streamName });
    await expectPlaying(viewer);
    await viewer.waitForTimeout(3000);

    const audio = await rtp(viewer, 'inbound-rtp');
    expect(audio, 'no inbound audio stream at all').not.toBeNull();
    expect(audio.packets, 'the probe stopped the audio arriving').toBeGreaterThan(0);

    await publisher.close();
    await viewer.close();
  });
});

test.describe('regressions from real use', () => {
  // Guards the per-rung sequence key: rungs sharing one counter show false missed frames.
  test('a simulcast publish reports no missed frames', async ({ browser }) => {
    const publisher = await browser.newPage();
    await publisher.goto('/#/publish');
    await requireEngine(publisher, test);

    const streamName = uniqueStream('rgsim');
    await waitForCamera(publisher);
    await openTab(publisher, 'Source');
    await publisher.locator('#publishUseSimulcast').check();
    await openTab(publisher, 'Advanced');
    await publisher.locator('#publishLatencyProbe').check();
    await openTab(publisher, 'Connection');
    await startPublishing(publisher, { streamName });
    await expectLive(publisher);

    const viewer = await browser.newPage();
    await viewer.goto('/#/play');
    await openTab(viewer, 'Advanced');
    await viewer.locator('#playLatencyProbe').check();
    await openTab(viewer, 'Connection');
    await startPlaying(viewer, { streamName });
    await expectPlaying(viewer);
    await viewer.waitForTimeout(10000);

    const missed = await viewer.evaluate(() => {
      const rows = [...document.querySelectorAll('.wz-latency__table tr')];
      const row = rows.find((r) => /frames missed/i.test(r.textContent));
      // The value cell only: the row's note also carries a number, the last stamp seen.
      return row ? row.querySelector('.wz-latency__value')?.textContent.trim() ?? null : null;
    });
    expect(missed, 'frames missed on a healthy simulcast session').toBe('0');

    await publisher.close();
    await viewer.close();
  });

  // The player leg and total need attachProbeVideoElement, the video-element half of the join;
  // the encoded half attaches to the receiver in startPlay.
  test('the panel reports all three figures, not just the transport leg', async ({ browser }) => {
    const publisher = await browser.newPage();
    await publisher.goto('/#/publish');
    await requireEngine(publisher, test);

    const streamName = uniqueStream('rgjoin');
    await waitForCamera(publisher);
    await openTab(publisher, 'Advanced');
    await publisher.locator('#publishLatencyProbe').check();
    await openTab(publisher, 'Connection');
    await startPublishing(publisher, { streamName });
    await expectLive(publisher);

    const viewer = await browser.newPage();
    await viewer.goto('/#/play');
    await openTab(viewer, 'Advanced');
    await viewer.locator('#playLatencyProbe').check();
    await openTab(viewer, 'Connection');
    await startPlaying(viewer, { streamName });
    await expectPlaying(viewer);
    await viewer.waitForTimeout(8000);

    const figures = await viewer.evaluate(() => {
      const rows = [...document.querySelectorAll('.wz-latency__table tr')];
      const read = (pattern) => {
        const row = rows.find((r) => pattern.test(r.textContent));
        if (!row) return null;
        const match = row.textContent.match(/(\d+)\s*ms/);
        return match ? Number(match[1]) : null;
      };
      return {
        transport: read(/publisher to player/i),
        player: read(/decode and display/i),
        total: read(/^\s*Total/i) ?? read(/Total/i),
      };
    });

    expect(figures.transport, 'the transport leg').toBeGreaterThan(0);
    expect(figures.player, 'the player jitter buffer, decode and display leg').not.toBeNull();
    expect(figures.total, 'the total').not.toBeNull();
    expect(figures.total).toBeGreaterThanOrEqual(figures.transport);

    await publisher.close();
    await viewer.close();
  });
});
