import { expect, test } from '@playwright/test';
import { listStreams, requireEngine, uniqueStream } from './helpers.js';
import { expectLive, openTab, startPublishing } from './ui-helpers.js';
import {
  RESOURCE,
  answerProbe,
  countPosts,
  expectRow,
  openPanel,
  panelRow,
  relaySessions,
  useTimings,
} from './reconnect-helpers.js';

/*
 * A publisher that loses its session on the Engine gets a new one. Each test does to a live
 * publish what an Engine or application restart does, from the server's side of the wire, and
 * checks what the server communication panel says, the Reconnecting badge, the second offer,
 * and LIVE again. Requires a reachable Engine.
 *
 * The first backoff is stretched to 2 s where a test has to see the badge, which a 1 s wait
 * would only just show.
 */

const RECONNECTING = '#video-live-indicator-reconnecting';
const SLOW_FIRST_RETRY = { delaysMs: [2000, 2000, 4000, 8000, 15000] };

const goLive = async (page, streamName, options = {}) => {
  await startPublishing(page, { streamName, ...options });
  await expectLive(page);
  await openPanel(page);
};

test.describe('publish reconnect over wss', () => {
  test('republishes on a fresh socket when the server closes the signaling socket', async ({ page }) => {
    await useTimings(page, SLOW_FIRST_RETRY);
    // Routes go in before the page loads; one added later missed the page's sockets.
    const relay = await relaySessions(page);
    await page.goto('/#/publish');
    await requireEngine(page, test);
    const streamName = uniqueStream('e2eReWs');
    await goLive(page, streamName);
    expect(relay.counts.OFFER).toBe(1);

    await relay.closeFromServer(1001, 'going away');

    await expectRow(page, 'error', 'publish socket closed unexpectedly (code 1001)');
    await expectRow(page, 'warn',
      'publish session lost (signaling socket closed unexpectedly (code 1001)): republishing, attempt 1 of 6 in');
    await expect(page.locator(RECONNECTING)).toHaveText('Reconnecting 1/6');
    await expect(page.locator('#publish-toggle')).toHaveText('Stop');

    await expectRow(page, 'info', 'publish republish attempt 1: new peer connection and signaling');
    await expectLive(page);
    await expectRow(page, 'info', /^publish recovered after \d+ attempts? \(/);
    await expect(page.locator(RECONNECTING)).toHaveCount(0);
    expect(relay.sockets.length).toBeGreaterThanOrEqual(2);
    expect(relay.counts.OFFER).toBeGreaterThanOrEqual(2);
    await expect.poll(async () => (await listStreams(page)) || [], { timeout: 20_000 }).toContain(streamName);
  });

  test('reads the Engine status off a 4410 close code', async ({ page }) => {
    // Routes go in before the page loads; one added later missed the page's sockets.
    const relay = await relaySessions(page);
    await page.goto('/#/publish');
    await requireEngine(page, test);
    await goLive(page, uniqueStream('e2eRe4410'));

    await relay.closeFromServer(4410, 'application shut down');

    await expectRow(page, 'error', 'publish socket closed unexpectedly (code 4410, Engine status 410)');
    await expectRow(page, 'warn',
      'publish session lost (the Engine ended the session (status 410: application shut down)): republishing');
    await expectLive(page);
    expect(relay.counts.OFFER).toBeGreaterThanOrEqual(2);
  });

  test('gives an unanswered ICE restart 8 s, then republishes', async ({ page }) => {
    // Routes go in before the page loads; one added later missed the page's sockets.
    const relay = await relaySessions(page);
    await page.goto('/#/publish');
    await requireEngine(page, test);
    await goLive(page, uniqueStream('e2eReIce'));

    relay.dropIceRestart = true;
    await openTab(page, 'Advanced');
    await page.locator('#ice-restart-toggle').click();
    await expect.poll(() => relay.counts.ICE_RESTART || 0).toBe(1);

    await expectRow(page, 'warn', 'publish ICE restart unanswered after 8 s', 15_000);
    await expectRow(page, 'warn', 'publish session lost (ICE restart unanswered after 8 s): republishing');
    relay.dropIceRestart = false;
    await expectLive(page);
    await expectRow(page, 'info', /^publish recovered after/);
    expect(relay.counts.OFFER).toBeGreaterThanOrEqual(2);
    // The old session was asked to go before the new one was offered.
    expect(relay.counts.CLOSE || 0).toBeGreaterThanOrEqual(1);
  });

  test('notices an application restart through the liveness check, and republishes', async ({ page }) => {
    await useTimings(page, { probeGraceMs: 2000, probeIntervalMs: 3000, probeRecheckMs: 1000 });
    const relay = await relaySessions(page);
    const streamName = uniqueStream('e2eReApp');
    const probe = await answerProbe(page, streamName);
    await page.goto('/#/publish');
    await requireEngine(page, test);
    await goLive(page, streamName);
    await expectRow(page, 'info', `publish liveness check: stream "${streamName}" is live on the Engine`);

    // What the check sees once the application has restarted under the session: no stream.
    probe.missing = true;
    await expectRow(page, 'warn', `publish stream "${streamName}" not listed by application`);
    await expectRow(page, 'error',
      `publish stream "${streamName}" no longer on the Engine (application "`);
    await expectRow(page, 'warn', `publish session lost (stream "${streamName}" no longer on the Engine): republishing`);
    probe.missing = false;

    await expectLive(page);
    await expectRow(page, 'info', /^publish recovered after/);
    expect(relay.counts.OFFER).toBeGreaterThanOrEqual(2);
    expect(relay.counts.CLOSE || 0).toBeGreaterThanOrEqual(1);
  });

  test('turns the liveness check off on a 400 without touching the publish', async ({ page }) => {
    await useTimings(page, { probeGraceMs: 1000, probeIntervalMs: 1500 });
    const streamName = uniqueStream('e2eReProbe400');
    const probe = await answerProbe(page, streamName);
    await page.goto('/#/publish');
    await requireEngine(page, test);
    probe.refuse = { statusCode: 400, statusDescription: 'Application live does not have WebRTC stream query enabled.' };
    await goLive(page, streamName);

    await expectRow(page, 'warn', 'publish liveness check off: the Engine refused it (400: Application live does not have WebRTC stream query enabled.)');
    await page.waitForTimeout(6000);
    await expect(panelRow(page, 'warn', 'publish liveness check off')).toHaveCount(1);
    expect(probe.asked).toBe(1);
    await expect(panelRow(page, 'warn', 'publish session lost')).toHaveCount(0);
    await expect(page.locator('#video-live-indicator-live')).toBeVisible();
  });

  test('stops during a reconnect', async ({ page }) => {
    await useTimings(page, SLOW_FIRST_RETRY);
    // Routes go in before the page loads; one added later missed the page's sockets.
    const relay = await relaySessions(page);
    await page.goto('/#/publish');
    await requireEngine(page, test);
    await goLive(page, uniqueStream('e2eReStop'));

    // Every new socket opens and is never answered, so the republish hangs where Stop can reach it.
    relay.hold = true;
    await relay.closeFromServer(1001, 'going away');
    await expect(page.locator(RECONNECTING)).toBeVisible();
    await expectRow(page, 'info', 'publish republish attempt 1: new peer connection and signaling');

    await page.locator('#publish-toggle').click();
    await expect(page.locator(RECONNECTING)).toHaveCount(0);
    await expect(page.locator('#publish-toggle')).toHaveText('Publish');
    await expectRow(page, 'info', 'publish recovery canceled by Stop during attempt 1 of 6');

    const offers = relay.counts.OFFER;
    await page.waitForTimeout(5000);
    expect(relay.counts.OFFER).toBe(offers);
    await expect(page.locator('#video-live-indicator-live')).toHaveCount(0);
    await expect(page.locator('#error-panel')).toHaveCount(0);
  });

  test('a healthy minute of publishing never republishes', async ({ page }) => {
    test.setTimeout(120_000);
    // Routes go in before the page loads; one added later missed the page's sockets.
    const relay = await relaySessions(page);
    await page.goto('/#/publish');
    await requireEngine(page, test);
    const streamName = uniqueStream('e2eReHealthy');
    await goLive(page, streamName);

    // The real timings: the check starts 15 s after LIVE and asks every 20 s.
    await page.waitForTimeout(60_000);
    await expect(page.locator('#video-live-indicator-live')).toBeVisible();
    await expect(panelRow(page, 'info', `publish liveness check: stream "${streamName}" is live on the Engine`)).toHaveCount(1);
    await expect(panelRow(page, 'warn', 'not listed by application')).toHaveCount(0);
    await expect(panelRow(page, 'warn', 'publish session lost')).toHaveCount(0);
    expect(relay.counts.OFFER).toBe(1);
    expect(relay.sockets.length).toBe(1);
  });
});

test.describe('publish reconnect over WHIP', () => {
  for (const status of [400, 404]) {
    test(`republishes with a new POST when the ICE restart PATCH is refused with ${status}`, async ({ page }) => {
      await page.goto('/#/publish');
      await requireEngine(page, test);
      const posts = countPosts(page, '/whip');
      await goLive(page, uniqueStream(`e2eReWhip${status}`), { useWhip: true });
      expect(posts.count).toBe(1);

      // Only the restart is refused; trickled candidates and the new POST go to the Engine.
      await page.route(RESOURCE('/whip'), async (route) => {
        const request = route.request();
        if (request.method() === 'PATCH' && /a=ice-ufrag/.test(request.postData() || '')) {
          await route.fulfill({ status, contentType: 'text/plain', body: 'No such WHIP session' });
          return;
        }
        await route.fallback();
      });

      await openTab(page, 'Advanced');
    await page.locator('#ice-restart-toggle').click();
      await expectRow(page, 'error', `WHIP ICE restart rejected (${status}): No such WHIP session`);
      await expectRow(page, 'warn', `publish session lost (WHIP ICE restart rejected (${status})): republishing`);
      await expectLive(page);
      await expectRow(page, 'info', /^publish recovered after/);
      expect(posts.count).toBeGreaterThanOrEqual(2);
      // The old resource was given back, best effort.
      expect(posts.deletes).toBeGreaterThanOrEqual(1);
    });
  }
});
