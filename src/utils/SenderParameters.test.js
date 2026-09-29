import { describe, expect, it, vi } from 'vitest';

import {
  AUDIO_MAX_BITRATE_KBPS,
  VIDEO_MAX_BITRATE_KBPS,
  applyAudioSenderParameters,
  applyInitialSenderParameters,
  applyVideoSenderParameters,
  videoSenderSettings,
  bpsToKbps,
  getMaxBitrateKbpsError,
  kbpsToBps,
  maxBitrateKbpsToApply,
} from './SenderParameters';
import { getEntries } from '../diagnostics/signalLog';

/*
 * A stand-in RTCRtpSender that behaves like Chrome's in the one way that matters here: a
 * setParameters built from anything but the latest getParameters is refused with
 * InvalidModificationError, and so is a second setParameters while one is still running.
 */
const fakeSender = (encodings = [{}], { delay = 0, failWith = null } = {}) => {
  let current = { transactionId: 't0', encodings: encodings.map((e) => ({ ...e })) };
  let transaction = 0;
  let inFlight = false;
  const sender = {
    written: [],
    overlaps: 0,
    getParameters: vi.fn(() => JSON.parse(JSON.stringify(current))),
    setParameters: vi.fn((parameters) => {
      if (inFlight) {
        sender.overlaps += 1;
        return Promise.reject(Object.assign(new Error('overlap'), { name: 'InvalidModificationError' }));
      }
      if (parameters.transactionId !== current.transactionId) {
        return Promise.reject(Object.assign(new Error('stale'), { name: 'InvalidModificationError' }));
      }
      if (failWith) return Promise.reject(failWith);
      inFlight = true;
      return new Promise((resolve) => setTimeout(() => {
        inFlight = false;
        transaction += 1;
        current = { ...JSON.parse(JSON.stringify(parameters)), transactionId: `t${transaction}` };
        sender.written.push(current);
        resolve();
      }, delay));
    }),
  };
  return sender;
};

describe('kbps and bps', () => {
  it('shows the stored bps as kbps', () => {
    expect(bpsToKbps(2500000)).toBe('2500');
    expect(bpsToKbps('700000')).toBe('700');
    expect(bpsToKbps(12345)).toBe('12.345');
    expect(bpsToKbps('x')).toBe('');
  });

  it('stores typed kbps as whole bps', () => {
    expect(kbpsToBps('2500')).toBe(2500000);
    expect(kbpsToBps(0.5)).toBe(500);
    expect(kbpsToBps('')).toBe(0);
    expect(kbpsToBps('abc')).toBe(0);
  });

  it('round trips the default ladder', () => {
    for (const bps of [2500000, 700000, 200000]) expect(kbpsToBps(bpsToKbps(bps))).toBe(bps);
  });
});

describe('getMaxBitrateKbpsError', () => {
  it('takes blank as no limit', () => {
    expect(getMaxBitrateKbpsError('', VIDEO_MAX_BITRATE_KBPS, 'Max video bitrate')).toBeNull();
    expect(getMaxBitrateKbpsError('  ', AUDIO_MAX_BITRATE_KBPS, 'Max audio bitrate')).toBeNull();
    expect(getMaxBitrateKbpsError(undefined, AUDIO_MAX_BITRATE_KBPS, 'x')).toBeNull();
  });

  it('accepts whole numbers inside the range, ends included', () => {
    expect(getMaxBitrateKbpsError('50', VIDEO_MAX_BITRATE_KBPS, 'v')).toBeNull();
    expect(getMaxBitrateKbpsError('20000', VIDEO_MAX_BITRATE_KBPS, 'v')).toBeNull();
    expect(getMaxBitrateKbpsError('6', AUDIO_MAX_BITRATE_KBPS, 'a')).toBeNull();
    expect(getMaxBitrateKbpsError('510', AUDIO_MAX_BITRATE_KBPS, 'a')).toBeNull();
  });

  it('refuses values outside the range, and says the range in kbps', () => {
    expect(getMaxBitrateKbpsError('49', VIDEO_MAX_BITRATE_KBPS, 'Max video bitrate'))
      .toBe('Max video bitrate must be from 50 to 20000 kbps, or blank for no limit');
    expect(getMaxBitrateKbpsError('511', AUDIO_MAX_BITRATE_KBPS, 'Max audio bitrate')).toMatch(/6 to 510 kbps/);
  });

  it('refuses what is not a whole number', () => {
    for (const bad of ['1.5', '-100', 'abc', '300k', '1e3']) {
      expect(getMaxBitrateKbpsError(bad, VIDEO_MAX_BITRATE_KBPS, 'v'), bad).toMatch(/whole number of kbps/);
    }
  });

  it('turns an invalid value into "leave the running cap alone"', () => {
    expect(maxBitrateKbpsToApply('10', VIDEO_MAX_BITRATE_KBPS)).toBeUndefined();
    expect(maxBitrateKbpsToApply('300', VIDEO_MAX_BITRATE_KBPS)).toBe('300');
    expect(maxBitrateKbpsToApply('', VIDEO_MAX_BITRATE_KBPS)).toBe('');
  });
});

describe('applyVideoSenderParameters, single stream', () => {
  it('sets the cap in bps on the only encoding', async () => {
    const sender = fakeSender();
    await expect(applyVideoSenderParameters(sender, { maxBitrateKbps: '300' })).resolves.toBe(true);
    expect(sender.written.at(-1).encodings[0].maxBitrate).toBe(300000);
  });

  it('removes the cap when the field is blank, which leaves it to the browser', async () => {
    const sender = fakeSender([{ maxBitrate: 300000 }]);
    await applyVideoSenderParameters(sender, { maxBitrateKbps: '' });
    expect(sender.written.at(-1).encodings[0]).not.toHaveProperty('maxBitrate');
  });

  it('leaves the cap alone when given undefined, and skips non-positive values', async () => {
    const sender = fakeSender([{ maxBitrate: 300000 }]);
    await applyVideoSenderParameters(sender, { maxBitrateKbps: undefined });
    expect(sender.written.at(-1).encodings[0].maxBitrate).toBe(300000);
    await applyVideoSenderParameters(sender, { maxBitrateKbps: '0' });
    expect(sender.written.at(-1).encodings[0].maxBitrate).toBe(300000);
  });

  it('sets and clears the degradation preference', async () => {
    const sender = fakeSender();
    await applyVideoSenderParameters(sender, { degradationPreference: 'maintain-framerate' });
    expect(sender.written.at(-1).degradationPreference).toBe('maintain-framerate');
    await applyVideoSenderParameters(sender, { degradationPreference: '' });
    expect(sender.written.at(-1)).not.toHaveProperty('degradationPreference');
  });

  it('ignores a preference the API does not define', async () => {
    const sender = fakeSender();
    await applyVideoSenderParameters(sender, { degradationPreference: 'sometimes' });
    expect(sender.written.at(-1)).not.toHaveProperty('degradationPreference');
  });

  it('never applies the single cap with simulcast on, even to a sender with no rids', async () => {
    // replaceVideoTrack adds a plain addTrack sender when there was none. The single cap's
    // field is disabled under simulcast, so its value may be stale and must not be sent.
    const sender = fakeSender([{ maxBitrate: 1000000 }]);
    await applyVideoSenderParameters(sender, {
      simulcast: true,
      renditions: [{ rid: 'h', scaleResolutionDownBy: 1, maxBitrate: 2500000 }],
      maxBitrateKbps: '100',
      degradationPreference: 'balanced',
    });
    const written = sender.written.at(-1);
    expect(written.encodings[0].maxBitrate).toBe(1000000);
    expect(written.degradationPreference).toBe('balanced');
  });

  it('resolves false and logs, without writing, when there are no encodings', async () => {
    const sender = fakeSender([]);
    await expect(applyVideoSenderParameters(sender, { maxBitrateKbps: '300' })).resolves.toBe(false);
    expect(sender.setParameters).not.toHaveBeenCalled();
    expect(getEntries().at(-1).label).toMatch(/video limits not applied/);
  });

  it('resolves false for something that is not a sender', async () => {
    await expect(applyVideoSenderParameters(null, {})).resolves.toBe(false);
    await expect(applyVideoSenderParameters({}, {})).resolves.toBe(false);
  });

  it('passes a setParameters failure to the caller', async () => {
    const failure = Object.assign(new Error('nope'), { name: 'OperationError' });
    const sender = fakeSender([{}], { failWith: failure });
    await expect(applyVideoSenderParameters(sender, { maxBitrateKbps: '300' })).rejects.toBe(failure);
  });
});

describe('applyVideoSenderParameters, simulcast', () => {
  const ladder = [
    { rid: 'h', scaleResolutionDownBy: 1, maxBitrate: 2500000 },
    { rid: 'm', scaleResolutionDownBy: 2, maxBitrate: 700000 },
    { rid: 'l', scaleResolutionDownBy: 4, maxBitrate: 200000 },
  ];

  it('copies scale down and max bitrate onto each encoding by rid', async () => {
    const sender = fakeSender([{ rid: 'h' }, { rid: 'm' }, { rid: 'l' }]);
    const edited = ladder.map((r) => (r.rid === 'm' ? { ...r, maxBitrate: 450000, scaleResolutionDownBy: '3' } : r));
    await applyVideoSenderParameters(sender, { simulcast: true, renditions: edited, maxBitrateKbps: '100' });

    const [h, m, l] = sender.written.at(-1).encodings;
    expect(h).toMatchObject({ rid: 'h', maxBitrate: 2500000, scaleResolutionDownBy: 1 });
    expect(m).toMatchObject({ rid: 'm', maxBitrate: 450000, scaleResolutionDownBy: 3 });
    expect(l).toMatchObject({ rid: 'l', maxBitrate: 200000, scaleResolutionDownBy: 4 });
  });

  it('leaves the single-stream cap out of it', async () => {
    const sender = fakeSender([{ rid: 'h', maxBitrate: 2500000 }]);
    await applyVideoSenderParameters(sender, { simulcast: true, renditions: ladder.slice(0, 1), maxBitrateKbps: '100' });
    expect(sender.written.at(-1).encodings[0].maxBitrate).toBe(2500000);
  });

  it('ignores renditions that were not negotiated and skips non-positive values', async () => {
    const sender = fakeSender([{ rid: 'h', maxBitrate: 2500000 }]);
    await applyVideoSenderParameters(sender, {
      simulcast: true,
      renditions: [{ rid: 'h', scaleResolutionDownBy: 0, maxBitrate: 0 }, { rid: 'x', scaleResolutionDownBy: 2, maxBitrate: 1 }],
    });
    expect(sender.written.at(-1).encodings).toEqual([{ rid: 'h', maxBitrate: 2500000 }]);
  });

  it('sets the degradation preference as well', async () => {
    const sender = fakeSender([{ rid: 'h' }]);
    await applyVideoSenderParameters(sender, { simulcast: true, renditions: ladder, degradationPreference: 'maintain-resolution' });
    expect(sender.written.at(-1).degradationPreference).toBe('maintain-resolution');
  });
});

describe('one apply at a time per sender', () => {
  it('never runs two setParameters on one sender at once, and reads fresh for each', async () => {
    const sender = fakeSender([{}], { delay: 5 });
    const first = applyVideoSenderParameters(sender, { maxBitrateKbps: '300' });
    const second = applyVideoSenderParameters(sender, { maxBitrateKbps: '400' });
    const third = applyVideoSenderParameters(sender, { degradationPreference: 'balanced' });
    await Promise.all([first, second, third]);

    expect(sender.overlaps).toBe(0);
    expect(sender.setParameters).toHaveBeenCalledTimes(3);
    // Each write was built from the read after the previous write, so the last one holds both.
    expect(sender.written.at(-1).encodings[0].maxBitrate).toBe(400000);
    expect(sender.written.at(-1).degradationPreference).toBe('balanced');
  });

  it('keeps going after a failed step', async () => {
    const sender = fakeSender([{}], { delay: 1 });
    const originalSet = sender.setParameters.getMockImplementation();
    sender.setParameters.mockImplementationOnce(() => Promise.reject(new Error('first fails')));
    const first = applyVideoSenderParameters(sender, { maxBitrateKbps: '300' });
    sender.setParameters.mockImplementation(originalSet);
    const second = applyVideoSenderParameters(sender, { maxBitrateKbps: '500' });

    await expect(first).rejects.toThrow('first fails');
    await expect(second).resolves.toBe(true);
    expect(sender.written.at(-1).encodings[0].maxBitrate).toBe(500000);
  });

  it('queues per sender, so the audio and video senders do not wait on each other', async () => {
    const video = fakeSender([{}], { delay: 20 });
    const audio = fakeSender([{}], { delay: 0 });
    const order = [];
    const v = applyVideoSenderParameters(video, { maxBitrateKbps: '300' }).then(() => order.push('video'));
    const a = applyAudioSenderParameters(audio, { maxBitrateKbps: '16' }).then(() => order.push('audio'));
    await Promise.all([v, a]);
    expect(order).toEqual(['audio', 'video']);
  });
});

describe('applyAudioSenderParameters', () => {
  it('sets and clears the audio cap', async () => {
    const sender = fakeSender();
    await applyAudioSenderParameters(sender, { maxBitrateKbps: '16' });
    expect(sender.written.at(-1).encodings[0].maxBitrate).toBe(16000);
    await applyAudioSenderParameters(sender, { maxBitrateKbps: '' });
    expect(sender.written.at(-1).encodings[0]).not.toHaveProperty('maxBitrate');
  });

  it('resolves false and logs when there are no encodings', async () => {
    const sender = fakeSender([]);
    await expect(applyAudioSenderParameters(sender, { maxBitrateKbps: '16' })).resolves.toBe(false);
    expect(getEntries().at(-1).label).toMatch(/audio limits not applied/);
  });
});

describe('applyInitialSenderParameters', () => {
  const settings = {
    useSimulcast: false,
    simulcastRenditions: [],
    videoMaxBitrateKbps: '300',
    audioMaxBitrateKbps: '16',
    degradationPreference: 'maintain-framerate',
  };

  it('caps both senders as soon as they exist', async () => {
    const video = fakeSender();
    const audio = fakeSender();
    await applyInitialSenderParameters({ videoSender: video, audioSender: audio }, settings);
    expect(video.written.at(-1).encodings[0].maxBitrate).toBe(300000);
    expect(video.written.at(-1).degradationPreference).toBe('maintain-framerate');
    expect(audio.written.at(-1).encodings[0].maxBitrate).toBe(16000);
  });

  it('shares the queue with the apply on connect, so the two never overlap', async () => {
    const video = fakeSender([{}], { delay: 5 });
    const initial = applyInitialSenderParameters({ videoSender: video }, settings);
    const onConnect = applyVideoSenderParameters(video, videoSenderSettings({ ...settings, videoMaxBitrateKbps: '250' }));
    await Promise.all([initial, onConnect]);
    expect(video.overlaps).toBe(0);
    expect(video.written.at(-1).encodings[0].maxBitrate).toBe(250000);
  });

  it('is harmless before negotiation: no encodings, a refused write, or no sender at all', async () => {
    const empty = fakeSender([]);
    const refusing = fakeSender([{}], { failWith: Object.assign(new Error('not yet'), { name: 'InvalidStateError' }) });
    await expect(applyInitialSenderParameters({ videoSender: empty, audioSender: refusing }, settings)).resolves.toBeDefined();
    await expect(applyInitialSenderParameters({}, settings)).resolves.toBeDefined();
    expect(getEntries().at(-1).label).toMatch(/audio limits not applied before negotiation/);
  });

  it('leaves the single cap out under simulcast', () => {
    expect(videoSenderSettings({ ...settings, useSimulcast: true }).maxBitrateKbps).toBeUndefined();
  });
});
