import { expect, test } from '@playwright/test';
import { listStreams, requireEngine, uniqueStream } from './helpers.js';
import { expectLive, expectPlaying, openTab, startPlaying, startPublishing, statValue } from './ui-helpers.js';
import {
  RESOURCE,
  countPosts,
  expectRow,
  openPanel,
  panelRow,
  relaySessions,
  useTimings,
} from './reconnect-helpers.js';

/*
 * A player that loses its session gets a new one, as the publisher does (see
 * reconnect-publish.spec.js). Every test publishes its own stream from a second page, so the
 * viewer has something it knows is live, and the routes are the viewer's alone.
 */

const RECONNECTING = '#video-play-indicator-reconnecting';
const SLOW_FIRST_RETRY = { delaysMs: [2000, 2000, 4000, 8000, 15000] };

const framesDecoded = async (page) => Number((await statValue(page, 'Frames decoded').textContent()) || 0);

// A publisher on its own page, with the stream listed by the Engine before anyone plays it.
const publishStream = async (browser, prefix, test) => {
  const publisher = await browser.newPage();
  await publisher.goto('/#/publish');
  await requireEngine(publisher, test);
  const streamName = uniqueStream(prefix);
  await startPublishing(publisher, { streamName });
  await expectLive(publisher);
  await expect.poll(async () => (await listStreams(publisher)) || [], { timeout: 25_000 }).toContain(streamName);
  return { publisher, streamName };
};

const playUntilDecoding = async (viewer, streamName, options = {}) => {
  await startPlaying(viewer, { streamName, ...options });
  await expectPlaying(viewer);
  await expect.poll(() => framesDecoded(viewer), { timeout: 25_000 }).toBeGreaterThan(0);
  await openPanel(viewer);
};

test.describe('play reconnect over wss', () => {
  test('replays on a fresh socket when the server closes the play socket', async ({ browser }) => {
    const { publisher, streamName } = await publishStream(browser, 'e2eRePlayWs', test);
    const viewer = await browser.newPage();
    await useTimings(viewer, SLOW_FIRST_RETRY);
    const relay = await relaySessions(viewer);
    await viewer.goto('/#/play');
    await playUntilDecoding(viewer, streamName);

    await relay.closeFromServer(1001, 'going away');

    await expectRow(viewer, 'error', 'play socket closed unexpectedly (code 1001)');
    await expectRow(viewer, 'warn',
      'play session lost (signaling socket closed unexpectedly (code 1001)): reconnecting, attempt 1 of 6 in');
    await expect(viewer.locator(RECONNECTING)).toHaveText('Reconnecting 1/6');
    await expect(viewer.locator('#play-toggle')).toHaveText('Stop');
    await expectRow(viewer, 'info', 'play reconnect attempt 1: new peer connection and signaling');

    await expectPlaying(viewer);
    await expectRow(viewer, 'info', /^play recovered after \d+ attempts? \(/);
    await expect(viewer.locator(RECONNECTING)).toHaveCount(0);
    expect(relay.counts.OFFER).toBeGreaterThanOrEqual(2);
    // New media on the new session: the counter belongs to the new connection.
    await expect.poll(() => framesDecoded(viewer), { timeout: 25_000 }).toBeGreaterThan(0);

    await viewer.close();
    await publisher.close();
  });

  test('waits out a publisher that stops and comes back under the same name', async ({ browser }) => {
    test.setTimeout(120_000);
    const { publisher, streamName } = await publishStream(browser, 'e2eRePlayGap', test);
    const viewer = await browser.newPage();
    await useTimings(viewer, { stallMs: 5000, stallPollMs: 1000 });
    await viewer.goto('/#/play');
    await playUntilDecoding(viewer, streamName);

    await publisher.locator('#publish-toggle').click();
    await expect(publisher.locator('#publish-toggle')).toHaveText('Publish');

    // The Engine may end the play session itself, or leave it up with no media; either way
    // the viewer calls it lost and starts replaying.
    await expectRow(viewer, 'warn', /^play session lost \(.+\): reconnecting, attempt 1 of 6/);
    await expect(viewer.locator(RECONNECTING)).toBeVisible();

    // Long enough for a replay to find the stream not running yet, which it has to wait out
    // rather than give up on.
    await viewer.waitForTimeout(4000);
    await publisher.locator('#publish-toggle').click();
    await expectLive(publisher);

    await expectPlaying(viewer);
    await expectRow(viewer, 'info', /^play recovered after \d+ attempts? \(/, 60_000);
    await expect.poll(() => framesDecoded(viewer), { timeout: 25_000 }).toBeGreaterThan(0);

    await viewer.close();
    await publisher.close();
  });

  test('stops during a reconnect', async ({ browser }) => {
    const { publisher, streamName } = await publishStream(browser, 'e2eRePlayStop', test);
    const viewer = await browser.newPage();
    await useTimings(viewer, SLOW_FIRST_RETRY);
    const relay = await relaySessions(viewer);
    await viewer.goto('/#/play');
    await playUntilDecoding(viewer, streamName);

    relay.hold = true;
    await relay.closeFromServer(1001, 'going away');
    await expect(viewer.locator(RECONNECTING)).toBeVisible();
    await expectRow(viewer, 'info', 'play reconnect attempt 1: new peer connection and signaling');

    await viewer.locator('#play-toggle').click();
    await expect(viewer.locator(RECONNECTING)).toHaveCount(0);
    await expect(viewer.locator('#play-toggle')).toHaveText('Play');
    await expectRow(viewer, 'info', 'play recovery canceled by Stop during attempt 1 of 6');

    const offers = relay.counts.OFFER;
    await viewer.waitForTimeout(5000);
    expect(relay.counts.OFFER).toBe(offers);
    await expect(viewer.locator('#video-play-indicator')).toHaveCount(0);

    await viewer.close();
    await publisher.close();
  });

  test('a healthy minute of playing never reconnects', async ({ browser }) => {
    test.setTimeout(150_000);
    const { publisher, streamName } = await publishStream(browser, 'e2eRePlayHealthy', test);
    const viewer = await browser.newPage();
    const relay = await relaySessions(viewer);
    await viewer.goto('/#/play');
    await playUntilDecoding(viewer, streamName);
    const before = await framesDecoded(viewer);

    await viewer.waitForTimeout(60_000);
    await expect(viewer.locator('#video-play-indicator')).toBeVisible();
    await expect(panelRow(viewer, 'warn', 'play inbound media stalled')).toHaveCount(0);
    await expect(panelRow(viewer, 'warn', 'play session lost')).toHaveCount(0);
    expect(relay.sockets.length).toBe(1);
    expect(await framesDecoded(viewer)).toBeGreaterThan(before);

    await viewer.close();
    await publisher.close();
  });
});

test.describe('play reconnect over WHEP', () => {
  test('replays with a new POST when the ICE restart PATCH is refused with 400', async ({ browser }) => {
    const { publisher, streamName } = await publishStream(browser, 'e2eRePlayWhep', test);
    const viewer = await browser.newPage();
    const posts = countPosts(viewer, '/whep');
    await viewer.goto('/#/play');
    await playUntilDecoding(viewer, streamName, { useWhep: true });
    expect(posts.count).toBe(1);

    await viewer.route(RESOURCE('/whep'), async (route) => {
      const request = route.request();
      if (request.method() === 'PATCH' && /a=ice-ufrag/.test(request.postData() || '')) {
        await route.fulfill({ status: 400, contentType: 'text/plain', body: 'No such WHEP session' });
        return;
      }
      await route.fallback();
    });

    await openTab(viewer, 'Advanced');
    await viewer.locator('#play-ice-restart-toggle').click();
    await expectRow(viewer, 'error', 'WHEP ICE restart rejected (400): No such WHEP session');
    await expectRow(viewer, 'warn', 'play session lost (WHEP ICE restart rejected (400)): reconnecting');
    await expectPlaying(viewer);
    await expectRow(viewer, 'info', /^play recovered after/);
    expect(posts.count).toBeGreaterThanOrEqual(2);
    expect(posts.deletes).toBeGreaterThanOrEqual(1);

    await viewer.close();
    await publisher.close();
  });
});
