import { afterEach, describe, expect, it, vi } from 'vitest';

import { reportRejectedVideo } from './startPublish';
import { clearLog, getEntries } from '../diagnostics/signalLog';

const answer = (videoLines) =>
  ['v=0', 'm=audio 7132 UDP/TLS/RTP/SAVPF 111', 'a=recvonly', ...videoLines].join('\r\n');

const REJECTED = answer(['m=video 0 UDP/TLS/RTP/SAVPF 0']);
const ACCEPTED = answer(['m=video 7134 UDP/TLS/RTP/SAVPF 96', 'a=recvonly']);

// A video track is all reportRejectedVideo checks for; it never touches the track itself.
const settings = (videoCodec = 'H264') => ({ videoTrack: {}, videoCodec });
const newSession = (videoCodecApplied = 'H264') =>
  ({ videoRejectionReported: false, videoCodecApplied });

afterEach(() => {
  vi.unstubAllGlobals();
  clearLog();
});

describe('reportRejectedVideo', () => {
  it('warns once per session, however many answers refuse video', () => {
    const onWarning = vi.fn();
    const session = newSession();
    reportRejectedVideo(REJECTED, settings(), { onWarning }, session);
    reportRejectedVideo(REJECTED, settings(), { onWarning }, session);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(session.videoRejectionReported).toBe(true);
  });

  // Every ICE restart brings another answer; a clean first one must not use up the report.
  it('does not latch on an answer that accepted video', () => {
    const onWarning = vi.fn();
    const session = newSession();
    reportRejectedVideo(ACCEPTED, settings(), { onWarning }, session);
    expect(session.videoRejectionReported).toBe(false);
    reportRejectedVideo(REJECTED, settings(), { onWarning }, session);
    expect(onWarning).toHaveBeenCalledTimes(1);
  });

  it('says nothing for an audio-only publish', () => {
    const onWarning = vi.fn();
    reportRejectedVideo(REJECTED, { videoTrack: null, videoCodec: 'H264' }, { onWarning }, newSession());
    expect(onWarning).not.toHaveBeenCalled();
  });

  // A throw in the handler must not escape into the caller's catch as a connection failure.
  it('contains a throwing warning callback and logs it', () => {
    const onWarning = vi.fn(() => { throw new Error('handler broke'); });
    const session = newSession();
    expect(() => reportRejectedVideo(REJECTED, settings(), { onWarning }, session)).not.toThrow();
    expect(session.videoRejectionReported).toBe(true);
    expect(getEntries().some((e) => /could not deliver the rejected-video warning/.test(e.label)))
      .toBe(true);
  });

  it('tolerates missing callbacks', () => {
    expect(() => reportRejectedVideo(REJECTED, settings(), undefined, newSession())).not.toThrow();
    expect(() => reportRejectedVideo(REJECTED, settings(), {}, newSession())).not.toThrow();
  });

  it('blames the Engine when the single-codec offer was sent', () => {
    const onWarning = vi.fn();
    reportRejectedVideo(REJECTED, settings('H264'), { onWarning }, newSession('H264'));
    expect(onWarning.mock.calls[0][0].message).toMatch(/does not accept H264/);
  });

  it('says the offer could not be restricted when the preference did not apply', () => {
    const onWarning = vi.fn();
    reportRejectedVideo(REJECTED, settings('H264'), { onWarning }, newSession(null));
    const { message } = onWarning.mock.calls[0][0];
    expect(message).toMatch(/could not restrict the offer to H264/);
    expect(message).not.toMatch(/does not accept H264/);
  });
});
