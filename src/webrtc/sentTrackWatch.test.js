import { beforeEach, describe, expect, it } from 'vitest';

import { clearLog, getEntries } from '../diagnostics/signalLog';
import { heldHandleCount, releaseSessionHandles } from './sessionHandles';
import replaceVideoTrack from './replaceVideoTrack';
import { watchSentTrack, watchedTrack } from './sentTrackWatch';

// EventTarget stands in for MediaStreamTrack, which jsdom does not have.
class FakeTrack extends EventTarget {
  constructor(label) {
    super();
    this.kind = 'video';
    this.label = label;
    this.readyState = 'live';
    this.muted = false;
  }

  stop() { this.readyState = 'ended'; }
}

const fakeSender = (track) => ({
  track,
  replaceTrack(next) { this.track = next; return Promise.resolve(); },
});

const labels = () => getEntries().map((e) => e.label);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => clearLog());

describe('watchSentTrack', () => {
  it('moves the listeners to the new track on a replace', async () => {
    const pc = {};
    const first = new FakeTrack('front');
    const second = new FakeTrack('back');
    const sender = fakeSender(first);
    watchSentTrack(pc, 'video', first);

    replaceVideoTrack(second, sender, pc, {});
    await flush();
    expect(watchedTrack(pc, 'video')).toBe(second);

    first.dispatchEvent(new Event('ended'));
    expect(labels()).not.toContain('publish outbound video track ended');

    second.dispatchEvent(new Event('mute'));
    expect(labels()).toContain('publish outbound video track muted by the browser');
  });

  // On mobile the old camera has to close before the new one opens.
  it('does not report a camera the page stopped itself as ended', () => {
    const pc = {};
    const track = new FakeTrack('front');
    watchSentTrack(pc, 'video', track);
    track.stop();
    track.dispatchEvent(new Event('ended'));
    const entry = getEntries().at(-1);
    expect(entry.label).toBe('publish outbound video track stopped by the page');
    expect(entry.direction).toBe('info');
    expect(track.readyState).toBe('ended');
  });

  it('still reports a track the browser ended as an error', () => {
    const pc = {};
    const track = new FakeTrack('front');
    watchSentTrack(pc, 'video', track);
    track.dispatchEvent(new Event('ended'));
    expect(getEntries().at(-1).direction).toBe('error');
  });

  it('releases everything and restores stop() when the session stops', () => {
    const pc = {};
    const track = new FakeTrack('front');
    watchSentTrack(pc, 'video', track);
    expect(Object.prototype.hasOwnProperty.call(track, 'stop')).toBe(true);
    expect(heldHandleCount(pc)).toBe(1);

    releaseSessionHandles(pc);
    expect(Object.prototype.hasOwnProperty.call(track, 'stop')).toBe(false);
    expect(watchedTrack(pc, 'video')).toBeNull();
    track.dispatchEvent(new Event('ended'));
    expect(getEntries()).toHaveLength(0);
  });

  it('watches nothing after a replace with null', async () => {
    const pc = {};
    const track = new FakeTrack('front');
    watchSentTrack(pc, 'video', track);
    replaceVideoTrack(null, fakeSender(track), pc, {});
    await flush();
    expect(watchedTrack(pc, 'video')).toBeNull();
    track.dispatchEvent(new Event('ended'));
    expect(getEntries()).toHaveLength(0);
  });

  it('does not start a watch on a closed connection', () => {
    const pc = { signalingState: 'closed' };
    watchSentTrack(pc, 'video', new FakeTrack('front'));
    expect(heldHandleCount(pc)).toBe(0);
  });

  it('keeps one watch when handed the same track again', () => {
    const pc = {};
    const track = new FakeTrack('front');
    watchSentTrack(pc, 'video', track);
    watchSentTrack(pc, 'video', track);
    track.dispatchEvent(new Event('mute'));
    expect(getEntries()).toHaveLength(1);
  });

  it('logs a replace the browser refused', async () => {
    const pc = {};
    const sender = { replaceTrack: () => Promise.reject(new Error('InvalidModificationError')) };
    replaceVideoTrack(new FakeTrack('back'), sender, pc, {});
    await flush();
    expect(getEntries().at(-1).label).toBe('publish could not replace the video track');
  });
});
