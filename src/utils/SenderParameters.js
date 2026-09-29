// Sender parameters
//
// The one place the publisher changes an RTCRtpSender's encoding parameters: the bitrate
// caps, the simulcast scale down and bitrate per rendition, and what the encoder gives up
// when the network cannot carry the cap.
//
// setParameters is a transaction against the last getParameters: each result carries a
// transactionId, and a second setParameters built from a stale read fails with
// InvalidModificationError. Two effects editing the same sender used to be able to race
// like that, so every change to a sender goes through one queue here, and each queued step
// reads the parameters fresh, changes them once and writes them once.

import { logEvent } from '../diagnostics/signalLog';

// The bounds the fields accept, in kbps. Video goes from a thumbnail to a 1080p ceiling;
// audio is the Opus range, 6 to 510 kbps.
export const VIDEO_MAX_BITRATE_KBPS = { min: 50, max: 20000 };
export const AUDIO_MAX_BITRATE_KBPS = { min: 6, max: 510 };

// '' is not a value the API knows: it is "Browser default", which is sent by leaving the
// field out of the parameters altogether.
export const DEGRADATION_PREFERENCE_OPTIONS = [
  { value: '', label: 'Browser default' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'maintain-framerate', label: 'Keep frame rate' },
  { value: 'maintain-resolution', label: 'Keep resolution' },
];

const DEGRADATION_PREFERENCES = new Set(
  DEGRADATION_PREFERENCE_OPTIONS.map((o) => o.value).filter(Boolean)
);

// The simulcast table stores bps, as the cookie and share link always have, so a saved
// ladder from before the table showed kbps still loads. The fields show kbps.
export const bpsToKbps = (bps) => {
  const value = Number(bps);
  if (!Number.isFinite(value)) return '';
  return String(Math.round(value) / 1000);
};

export const kbpsToBps = (kbps) => {
  if (kbps === '' || kbps == null) return 0;
  const value = Number(kbps);
  return Number.isFinite(value) ? Math.round(value * 1000) : 0;
};

/**
 * An error message for a bitrate cap field, or null when it can be applied. Blank is valid:
 * it means no cap, so the browser decides.
 */
export const getMaxBitrateKbpsError = (value, range, what) => {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  if (!/^\d+$/.test(text))
    return `${what} must be a whole number of kbps, or blank for no limit`;
  const kbps = Number(text);
  if (kbps < range.min || kbps > range.max)
    return `${what} must be from ${range.min} to ${range.max} kbps, or blank for no limit`;
  return null;
};

/*
 * A cap as the apply functions take it. undefined leaves the encoding's current cap alone,
 * which is what an invalid field asks for: its error is on screen and the last good value
 * keeps running. Blank clears the cap.
 */
export const maxBitrateKbpsToApply = (value, range) => {
  if (getMaxBitrateKbpsError(value, range, '') != null) return undefined;
  return String(value ?? '').trim();
};

const queues = new WeakMap();

/*
 * Runs task after every earlier task for this sender has settled, whatever its outcome, so
 * one failure does not wedge the queue. Returns task's own promise, so the caller still
 * sees its error.
 */
const enqueue = (sender, task) => {
  const previous = queues.get(sender) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  queues.set(sender, next);
  return next;
};

// Writes one cap onto an encoding. undefined leaves it, blank removes it, and a positive
// number sets it; anything else is skipped rather than sent.
const setMaxBitrate = (encoding, kbps) => {
  if (kbps === undefined) return;
  if (kbps === '' || kbps === null) {
    delete encoding.maxBitrate;
    return;
  }
  const bps = kbpsToBps(kbps);
  if (bps > 0) encoding.maxBitrate = bps;
};

const setDegradationPreference = (parameters, preference) => {
  if (preference === undefined) return;
  if (preference === '' || preference === null) {
    delete parameters.degradationPreference;
    return;
  }
  if (DEGRADATION_PREFERENCES.has(preference)) parameters.degradationPreference = preference;
};

// Resolves to false, rather than failing, when the sender has nothing to set yet: a sender
// with no encodings cannot take a cap, and that is worth a line in the log, not a banner.
const readParameters = (sender, kind) => {
  const parameters = sender.getParameters();
  if (!parameters || !Array.isArray(parameters.encodings) || parameters.encodings.length === 0) {
    logEvent('warn', 'pc', `publish ${kind} limits not applied: the sender has no encodings yet`);
    return null;
  }
  return parameters;
};

const usable = (sender) => sender != null && typeof sender.getParameters === 'function'
  && typeof sender.setParameters === 'function';

/**
 * Applies the video settings to the video sender in one read and one write.
 *
 * With simulcast, each negotiated encoding takes its rendition's scale down and max bitrate,
 * matched by rid; renditions that were not negotiated are ignored. The single max bitrate
 * never applies with simulcast on, not even to a sender that has no rids (one added by
 * replaceVideoTrack): its field is disabled then, so whatever it holds is stale, and a
 * limit nobody can see or edit must not reach the wire.
 *
 * The a=rid max-br in the offer is written once, from the renditions at publish time, and
 * only informs the Engine: setLocalDescription has already run when ensureSimulcastSDP edits
 * the text. A live edit here changes the encoder and leaves that announced figure stale.
 *
 * Resolves true when parameters were written, false when there was nothing to write to.
 */
export const applyVideoSenderParameters = (sender, settings = {}) => {
  if (!usable(sender)) return Promise.resolve(false);

  return enqueue(sender, () => {
    const parameters = readParameters(sender, 'video');
    if (!parameters) return false;

    const { simulcast, renditions, maxBitrateKbps, degradationPreference } = settings;
    const hasRids = parameters.encodings.some((encoding) => encoding.rid);

    if (simulcast && hasRids) {
      const renditionsByRid = new Map((renditions || []).map((r) => [r.rid, r]));
      parameters.encodings.forEach((encoding) => {
        const rendition = renditionsByRid.get(encoding.rid);
        if (!rendition) return;
        const scale = Number(rendition.scaleResolutionDownBy);
        if (scale >= 1) encoding.scaleResolutionDownBy = scale;
        const bps = Number(rendition.maxBitrate);
        if (bps > 0) encoding.maxBitrate = Math.round(bps);
      });
    } else if (!simulcast) {
      setMaxBitrate(parameters.encodings[0], maxBitrateKbps);
    }

    setDegradationPreference(parameters, degradationPreference);

    return sender.setParameters(parameters).then(() => true);
  });
};

/** Applies the audio cap to the audio sender in one read and one write. */
export const applyAudioSenderParameters = (sender, settings = {}) => {
  if (!usable(sender)) return Promise.resolve(false);

  return enqueue(sender, () => {
    const parameters = readParameters(sender, 'audio');
    if (!parameters) return false;

    setMaxBitrate(parameters.encodings[0], settings.maxBitrateKbps);

    return sender.setParameters(parameters).then(() => true);
  });
};

/*
 * The settings each sender takes, from the publish settings in the store. Shared by the two
 * callers, startPublish and the Publisher's effects, so both always send the same thing.
 * Under simulcast the single cap's field is disabled and may hold a stale value, so it is
 * left out entirely.
 */
export const videoSenderSettings = (publishSettings) => ({
  simulcast: Boolean(publishSettings.useSimulcast),
  renditions: publishSettings.simulcastRenditions,
  maxBitrateKbps: publishSettings.useSimulcast
    ? undefined
    : maxBitrateKbpsToApply(publishSettings.videoMaxBitrateKbps, VIDEO_MAX_BITRATE_KBPS),
  degradationPreference: publishSettings.degradationPreference,
});

export const audioSenderSettings = (publishSettings) => ({
  maxBitrateKbps: maxBitrateKbpsToApply(publishSettings.audioMaxBitrateKbps, AUDIO_MAX_BITRATE_KBPS),
});

/*
 * The first apply, as soon as startPublish has made the senders, so a single stream never
 * starts uncapped while ICE and the answer are on their way. It goes through the same
 * per-sender queue as every later change, so it cannot race the apply that follows on
 * connect. Before negotiation a sender may have no encodings yet, or refuse the write; both
 * are only logged, because the apply on connect runs again and reports a real failure.
 */
export const applyInitialSenderParameters = ({ videoSender, audioSender }, publishSettings) => {
  const logFailure = (kind) => (error) => logEvent('warn', 'pc',
    `publish ${kind} limits not applied before negotiation; they are applied again on connect`,
    error?.message ?? String(error));
  return Promise.all([
    applyVideoSenderParameters(videoSender, videoSenderSettings(publishSettings)).catch(logFailure('video')),
    applyAudioSenderParameters(audioSender, audioSenderSettings(publishSettings)).catch(logFailure('audio')),
  ]);
};
