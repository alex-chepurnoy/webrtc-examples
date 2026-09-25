/*
 * Samples RTCPeerConnection.getStats() on an interval and reduces it to on-screen numbers.
 *
 *   estimatedLatencyMs = (RTT / 2) + jitter buffer delay
 *
 * A receiver-side estimate only: it excludes capture, encode, Engine processing, decode and
 * display, so glass-to-glass latency is higher. Label it as an estimate wherever shown.
 * RTT is measured: currentRoundTripTime on the active ICE candidate pair.
 */

const KIND = "video";

const findById = (report, id) => {
  if (!id) return null;
  if (typeof report.get === "function") {
    const direct = report.get(id);
    if (direct) return direct;
  }
  let found = null;
  report.forEach((s) => {
    if (s.id === id && !found) found = s;
  });
  return found;
};

/*
 * The pair carrying media right now. transport.selectedCandidatePairId names it; after an ICE
 * restart the old pairs can stay nominated and succeeded, so the first nominated pair is only
 * a fallback for a browser that does not report the selected one.
 */
const pickCandidatePair = (report) => {
  let selectedId = null;
  report.forEach((s) => {
    if (s.type === "transport" && s.selectedCandidatePairId && !selectedId) selectedId = s.selectedCandidatePairId;
  });
  const selected = findById(report, selectedId);
  if (selected && selected.type === "candidate-pair") return selected;

  let best = null;
  report.forEach((s) => {
    if (s.type !== "candidate-pair") return;
    // A connection can hold several pairs; the nominated succeeded one is the live path.
    const usable = s.state === "succeeded" && (s.nominated || s.selected || best === null);
    if (usable) {
      if (!best || (s.nominated && !best.nominated)) best = s;
    }
  });
  return best;
};

const findBy = (report, type, predicate) => {
  let found = null;
  report.forEach((s) => {
    if (s.type === type && (!predicate || predicate(s)) && !found) found = s;
  });
  return found;
};

const collect = (report, type, predicate) => {
  const found = [];
  report.forEach((s) => {
    if (s.type === type && (!predicate || predicate(s))) found.push(s);
  });
  return found;
};

const byId = (list) => new Map(list.map((s) => [s.id, s]));

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** A counter's growth since the previous stat; null with no previous, or when it went back. */
const delta = (current, previous, field) => {
  if (!current || !previous || !isNumber(current[field]) || !isNumber(previous[field])) return null;
  const grown = current[field] - previous[field];
  return grown < 0 ? null : grown;
};

/*
 * Per second over the interval between two stats. Each stat carries the time the browser
 * measured it, which is what its counters are relative to; when the poll happened to resolve
 * is only the fallback.
 */
const perSecond = (current, previous, field, nowMs, thenMs) => {
  const grown = delta(current, previous, field);
  if (grown === null) return null;
  const ms = isNumber(current.timestamp) && isNumber(previous.timestamp)
    ? current.timestamp - previous.timestamp
    : nowMs - thenMs;
  if (ms <= 0) return null;
  return grown / (ms / 1000);
};

const toKbps = (bps) => (bps === null ? null : (bps * 8) / 1000);

/** Rates summed across stats matched to their previous sample by id; null when none has one. */
const summedRate = (current, previousById, field, nowMs, thenMs) => {
  let total = null;
  current.forEach((stat) => {
    const before = previousById.get(stat.id);
    const rate = before ? perSecond(stat, before, field, nowMs, thenMs) : null;
    if (rate !== null) total = (total ?? 0) + rate;
  });
  return total;
};

/*
 * The headline encoding on a simulcast publish: the largest picture among the rungs that
 * sent something this interval, then among the active ones. The browser lists encodings in
 * no promised order, and the first one found was whichever rung happened to come first.
 */
const pickTopEncoding = (encodings, isSending) => {
  if (encodings.length <= 1) return encodings[0] || null;
  const area = (s) => (s.frameWidth ?? 0) * (s.frameHeight ?? 0);
  const largest = (list) => list.reduce((top, s) => (!top || area(s) > area(top) ? s : top), null);
  return largest(encodings.filter(isSending))
    || largest(encodings.filter((s) => s.active !== false))
    || largest(encodings);
};

/**
 * Reduces one getStats() report to a flat summary.
 * `previous` is the raw report from the last sample. Rates, the jitter buffer, packet loss
 * and whether a simulcast rung is sending are all measured over the interval between the two.
 */
export const summarizeStats = (report, previous, nowMs, thenMs) => {
  const pair = pickCandidatePair(report);
  const inboundVideo = findBy(report, "inbound-rtp", (s) => s.kind === KIND);
  const inboundAudio = findBy(report, "inbound-rtp", (s) => s.kind === "audio");
  const outboundAudio = findBy(report, "outbound-rtp", (s) => s.kind === "audio");

  // One outbound-rtp per simulcast encoding, each matched to its previous sample by id.
  const outboundVideoAll = collect(report, "outbound-rtp", (s) => s.kind === KIND);
  const prevOutboundVideoById = byId(
    previous ? collect(previous, "outbound-rtp", (s) => s.kind === KIND) : []
  );

  /*
   * Sending means bytes left in this interval. bytesSent is a session total and stays above
   * zero for good once a rung has sent anything, so it cannot show that the browser has since
   * turned the rung off. null until there are two samples to tell.
   */
  const sentThisInterval = (s) => {
    if (s.active === false) return false;
    const grown = delta(s, prevOutboundVideoById.get(s.id), "bytesSent");
    return grown === null ? null : grown > 0;
  };
  const outboundVideo = pickTopEncoding(outboundVideoAll, (s) => sentThisInterval(s) === true);

  // Prefer video, fall back to audio: an audio-only connection still has a jitter buffer
  // and a latency worth reporting.
  const inbound = inboundVideo || inboundAudio;
  const outbound = outboundVideo || outboundAudio;
  const remoteInbound = findBy(report, "remote-inbound-rtp", (s) => s.kind === KIND);
  const prevInbound = previous && inbound
    ? findBy(previous, "inbound-rtp", (s) => s.kind === inbound.kind)
    : null;

  // Prefer the ICE pair RTT; fall back to the RTT the receiver reports over RTCP.
  const rttSeconds =
    pair && typeof pair.currentRoundTripTime === "number"
      ? pair.currentRoundTripTime
      : remoteInbound && typeof remoteInbound.roundTripTime === "number"
        ? remoteInbound.roundTripTime
        : null;

  /*
   * The buffer over this interval, not the session. Both counters are cumulative, so they
   * are differenced against the previous sample; otherwise the drift watcher misses changes.
   * An interval in which no frame left the buffer has no figure: the session average in its
   * place would read as current. The first sample has no previous, and its interval is the
   * session so far.
   */
  const jitterBufferMsFrom = (delay, count) =>
    (typeof delay === "number" && typeof count === "number" && count > 0
      ? (delay / count) * 1000
      : null);

  let jitterBufferMs = null;
  if (inbound) {
    jitterBufferMs = prevInbound
      ? jitterBufferMsFrom(
        delta(inbound, prevInbound, "jitterBufferDelay"),
        delta(inbound, prevInbound, "jitterBufferEmittedCount"))
      : jitterBufferMsFrom(inbound.jitterBufferDelay, inbound.jitterBufferEmittedCount);
  }

  const rttMs = rttSeconds === null ? null : rttSeconds * 1000;
  const estimatedLatencyMs =
    rttMs === null && jitterBufferMs === null
      ? null
      : (rttMs === null ? 0 : rttMs / 2) + (jitterBufferMs === null ? 0 : jitterBufferMs);

  const inboundBps = prevInbound
    ? perSecond(inbound, prevInbound, "bytesReceived", nowMs, thenMs)
    : null;

  // Summed across every encoding, so it matches the simulcast total shown beneath it.
  const outboundVideoBps = previous
    ? summedRate(outboundVideoAll, prevOutboundVideoById, "bytesSent", nowMs, thenMs)
    : null;
  const outboundAudioBps = previous && outboundAudio
    ? summedRate([outboundAudio],
      byId(collect(previous, "outbound-rtp", (s) => s.kind === "audio")), "bytesSent", nowMs, thenMs)
    : null;
  const outboundBps = outboundVideoAll.length > 0 ? outboundVideoBps : outboundAudioBps;

  // Video alone, in whichever direction this side carries it; null on an audio-only session.
  let videoBps = null;
  if (inboundVideo) videoBps = inboundBps;
  else if (outboundVideoAll.length > 0) videoBps = outboundVideoBps;

  // The codec is a separate stat referenced by codecId.
  const rtp = inboundVideo || outboundVideo;
  let codec = null;
  if (rtp && rtp.codecId) {
    report.forEach((s) => {
      if (s.type === 'codec' && s.id === rtp.codecId && s.mimeType) {
        codec = s.mimeType.replace(/^video\//i, '').replace(/^audio\//i, '');
      }
    });
  }

  /*
   * A layer at zero bytes is not a bug: Chromium turns layers off when bandwidth will not
   * carry them and refuses sizes below its floor, so qualityLimitationReason is carried
   * through to say why.
   */
  const outboundLayers = outboundVideoAll
    .filter((s) => s.rid !== undefined && s.rid !== null)
    .map((s) => {
      const before = prevOutboundVideoById.get(s.id);
      const bps = before ? perSecond(s, before, "bytesSent", nowMs, thenMs) : null;
      return {
        rid: s.rid,
        frameWidth: s.frameWidth ?? null,
        frameHeight: s.frameHeight ?? null,
        framesPerSecond: s.framesPerSecond ?? null,
        kbps: toKbps(bps),
        bytesSent: s.bytesSent ?? 0,
        framesEncoded: s.framesEncoded ?? 0,
        // active is the encoding being asked for; sending is whether anything came out.
        active: s.active !== false,
        sending: sentThisInterval(s),
        limitedBy: s.qualityLimitationReason && s.qualityLimitationReason !== 'none'
          ? s.qualityLimitationReason
          : null,
      };
    })
    // Sorted by rid only: Chromium omits scaleResolutionDownBy on outbound-rtp, so an idle
    // rung has nothing to rank by. SimulcastLayers orders from the configured renditions.
    .sort((a, b) => String(a.rid).localeCompare(String(b.rid)));

  /*
   * Loss over the last interval, not the session, so a burst a minute ago does not still
   * read as loss now. A receiver divides by what it should have received; a sender divides
   * by what it sent, with the loss count from RTCP remote-inbound-rtp, summed across simulcast
   * rungs. The first sample's interval is the session so far. packetsLost stays the session
   * total.
   */
  const remoteInboundAll = collect(report, "remote-inbound-rtp", (s) => s.kind === KIND);
  const sum = (list, field) =>
    list.reduce((total, s) => (isNumber(s[field]) ? total + s[field] : total), 0);
  // Growth summed across stats; a stat new since the previous sample counts from zero.
  const summedGrowth = (list, previousById, field) =>
    list.reduce((total, s) => {
      const before = previousById.get(s.id);
      if (!before) return isNumber(s[field]) ? total + s[field] : total;
      return total + (delta(s, before, field) ?? 0);
    }, 0);

  let packetsLost = null;
  let lostInInterval = null;
  let expectedInInterval = null;

  if (inbound && typeof inbound.packetsReceived === "number") {
    packetsLost = inbound.packetsLost ?? 0;
    if (prevInbound && isNumber(prevInbound.packetsReceived)) {
      const received = delta(inbound, prevInbound, "packetsReceived");
      // packetsLost steps back when a late duplicate arrives; that is no loss, not a gain.
      const lost = Math.max(0, packetsLost - (prevInbound.packetsLost ?? 0));
      if (received !== null) {
        lostInInterval = lost;
        expectedInInterval = received + lost;
      }
    } else {
      lostInInterval = packetsLost;
      expectedInInterval = inbound.packetsReceived + packetsLost;
    }
  } else if (remoteInboundAll.length > 0 && outboundVideoAll.length > 0) {
    packetsLost = sum(remoteInboundAll, "packetsLost");
    const prevRemoteById = byId(
      previous ? collect(previous, "remote-inbound-rtp", (s) => s.kind === KIND) : []
    );
    lostInInterval = summedGrowth(remoteInboundAll, prevRemoteById, "packetsLost");
    expectedInInterval = summedGrowth(outboundVideoAll, prevOutboundVideoById, "packetsSent");
  }

  return {
    at: nowMs,
    rttMs,
    jitterBufferMs,
    estimatedLatencyMs,
    // Only meaningful when the estimate has both halves; the UI uses it to add a caveat.
    latencyIsPartial: rttMs === null || jitterBufferMs === null,
    jitterMs: typeof inbound?.jitter === "number" ? inbound.jitter * 1000 : null,
    packetsLost,
    packetLossPct:
      expectedInInterval && expectedInInterval > 0 && lostInInterval !== null
        ? (lostInInterval / expectedInInterval) * 100
        : null,
    // Whole direction, video or else audio; the watcher's bitrate line reads these.
    inboundKbps: toKbps(inboundBps),
    outboundKbps: toKbps(outboundBps),
    // Video alone, for the tile that says video.
    videoKbps: toKbps(videoBps),
    // Frame figures come from the top rung, the one the viewer of the source rendition sees.
    framesPerSecond: inboundVideo?.framesPerSecond ?? outboundVideo?.framesPerSecond ?? null,
    frameWidth: inboundVideo?.frameWidth ?? outboundVideo?.frameWidth ?? null,
    frameHeight: inboundVideo?.frameHeight ?? outboundVideo?.frameHeight ?? null,
    codec,
    framesDecoded: inboundVideo?.framesDecoded ?? null,
    framesDropped: inboundVideo?.framesDropped ?? null,
    keyFramesDecoded: inboundVideo?.keyFramesDecoded ?? null,
    framesEncoded: outboundVideo?.framesEncoded ?? null,
    // Audio reported separately, so lost audio is distinguishable from none.
    audioCodec: (() => {
      const audioRtp = inboundAudio || outboundAudio;
      if (!audioRtp || !audioRtp.codecId) return null;
      let found = null;
      report.forEach((entry) => {
        if (entry.type === 'codec' && entry.id === audioRtp.codecId && entry.mimeType) {
          found = entry.mimeType.replace(/^audio\//i, '');
        }
      });
      return found;
    })(),
    audioKbps: (() => {
      const current = inboundAudio || outboundAudio;
      if (!current || !previous) return null;
      const field = inboundAudio ? 'bytesReceived' : 'bytesSent';
      const before = findBy(previous, inboundAudio ? 'inbound-rtp' : 'outbound-rtp',
        (entry) => entry.kind === 'audio');
      if (!before) return null;
      return toKbps(perSecond(current, before, field, nowMs, thenMs));
    })(),
    audioLevel: typeof inboundAudio?.audioLevel === 'number' ? inboundAudio.audioLevel : null,
    // Why the top rung's encoder is holding back: 'bandwidth', 'cpu', 'other'.
    qualityLimitation:
      outboundVideo?.qualityLimitationReason && outboundVideo.qualityLimitationReason !== 'none'
        ? outboundVideo.qualityLimitationReason
        : null,
    // Empty unless the publish is actually simulcast; one unnamed encoding is not a layer list.
    outboundLayers: outboundLayers.length > 1 ? outboundLayers : [],
    outboundTotalKbps: outboundLayers.length > 1
      ? outboundLayers.reduce((total, l) => total + (l.kbps ?? 0), 0)
      : null,
    // A publisher has no receive path; the UI hides receiver-side latency tiles.
    isReceiving: Boolean(inbound),
    isSending: Boolean(outbound),
    hasVideo: Boolean(inboundVideo || outboundVideo),
    hasAudio: Boolean(inboundAudio || outboundAudio),
    // host, srflx, prflx or relay: whether media goes direct, through a NAT or through TURN.
    // Resolved through the id: localCandidateId itself is opaque.
    localCandidateType: (() => {
      const candidate = pair ? findById(report, pair.localCandidateId) : null;
      return candidate && candidate.type === 'local-candidate' ? (candidate.candidateType ?? null) : null;
    })(),
    availableOutgoingKbps:
      pair && typeof pair.availableOutgoingBitrate === "number"
        ? pair.availableOutgoingBitrate / 1000
        : null,
  };
};

/**
 * Polls until the returned stop() is called. Safe to call with a null peer connection,
 * which is the state between "page loaded" and "stream started".
 */
export const startStatsPolling = (peerConnection, onSample, intervalMs = 1000) => {
  if (!peerConnection || typeof peerConnection.getStats !== "function") return () => {};

  let stopped = false;
  let inFlight = false;
  let previous = null;
  let previousAt = 0;

  const tick = async () => {
    // A getStats slower than the interval must not start a second one over the first.
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const report = await peerConnection.getStats(null);
      // Stopped while the report was on its way: nobody is listening any more.
      if (stopped) return;
      const now = Date.now();
      onSample(summarizeStats(report, previous, now, previousAt));
      previous = report;
      previousAt = now;
    } catch {
      // A connection closed mid-poll throws; the next tick stops or recovers on its own.
    } finally {
      inFlight = false;
    }
  };

  tick();
  const handle = setInterval(tick, intervalMs);

  return () => {
    stopped = true;
    clearInterval(handle);
  };
};
