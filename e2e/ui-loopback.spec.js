import { test, expect } from '@playwright/test';

import {
  requireEngine,
  uniqueStream,
} from './helpers.js';
import {
  expectLive,
  expectPlaying,
  startPlaying,
  startPublishing,
} from './ui-helpers.js';

/*
 * The combined page, which carries a publisher and a player at once and is the
 * only place their two sets of figures appear together.
 */

test.describe('combined page alignment', () => {
  test('the pictures start together and the stat strips end together', async ({ page }) => {
    await requireEngine(page, test);
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto('/#/loopback');

    const streamName = uniqueStream('align');
    await startPublishing(page, { streamName });
    await expectLive(page);
    await page.getByRole('button', { name: 'Player', exact: true }).click();
    await startPlaying(page, { streamName });
    await expectPlaying(page);
    await page.waitForTimeout(3000);

    const geom = await page.evaluate(() => {
      const panes = [...document.querySelectorAll('.wz-loopback__pane')];
      const box = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; };
      return {
        videoTops: panes.map((p) => box(p.querySelector('video')).top),
        stripBottoms: panes.map((p) => box(p.querySelector('.wz-statgroups')).bottom),
      };
    });

    expect(geom.videoTops[0]).toBe(geom.videoTops[1]);
    expect(geom.stripBottoms[0]).toBe(geom.stripBottoms[1]);
  });
});


test.describe('combined page settings', () => {
  test('the player settings are filled from the publisher in one click', async ({ page }) => {
    await page.goto('/#/loopback');

    await page.fill('#signalingURL', 'wss://engine.example/webrtc-session.json');
    await page.fill('#applicationName', 'webrtc');
    await page.fill('#streamName', 'copyMe');

    await page.getByRole('button', { name: 'Player', exact: true }).click();
    await expect(page.locator('#playStreamName')).toHaveValue('');

    await page.locator('#copy-from-publisher').click();

    await expect(page.locator('#playSignalingURL')).toHaveValue('wss://engine.example/webrtc-session.json');
    await expect(page.locator('#playApplicationName')).toHaveValue('webrtc');
    await expect(page.locator('#playStreamName')).toHaveValue('copyMe');
  });

  // The Engine keeps the WHIP and WHEP tokens as separate settings, so one must never fill the other.
  test('the WHIP auth token is not copied into the WHEP auth token', async ({ page }) => {
    await page.goto('/#/loopback');
    await page.locator('#publishUseWhip').check();
    await page.fill('#publishAuthToken', 'whip-only-token');
    await page.fill('#streamName', 'noTokenCopy');

    await page.getByRole('button', { name: 'Player', exact: true }).click();
    await page.locator('#playUseWhep').check();
    await page.fill('#playAuthToken', 'whep-own-token');
    await page.locator('#copy-from-publisher').click();

    await expect(page.locator('#playStreamName')).toHaveValue('noTokenCopy');
    await expect(page.locator('#playAuthToken')).toHaveValue('whep-own-token');
    await expect(page.locator('#playAuthToken')).not.toHaveValue('whip-only-token');
    await expect(page.locator('#copy-from-publisher + small')).not.toContainText(/token/i);
  });

  test('WHIP on the publisher becomes WHEP on the player', async ({ page }) => {
    await page.goto('/#/loopback');
    await page.locator('#publishUseWhip').check();
    await page.fill('#streamName', 'whipCopy');

    await page.getByRole('button', { name: 'Player', exact: true }).click();
    await page.locator('#copy-from-publisher').click();

    await expect(page.locator('#playUseWhep')).toBeChecked();
  });
});

// A latency change during a session should produce a log line naming both values.


/*
 * Chat on the combined page is one collapsible section under the two panes, shown only while
 * chat is enabled on at least one side. Both sides share one page, so a message sent from one
 * panel arrives in the other through the Engine.
 */
test.describe('combined page chat', () => {
  const enableChat = async (page, { publish = false, play = false }) => {
    if (publish) {
      await page.getByRole('button', { name: 'Publisher', exact: true }).click();
      await page.locator('#publishChatEnabled').check();
    }
    if (play) {
      await page.getByRole('button', { name: 'Player', exact: true }).click();
      await page.locator('#playChatEnabled').check();
    }
  };

  const toggle = (page) => page.locator('#loopback-chat-toggle');

  test('is absent while chat is off on both sides', async ({ page }) => {
    await page.goto('/#/loopback');
    await expect(page.locator('#loopback-chat')).toHaveCount(0);

    await enableChat(page, { play: true });
    await expect(toggle(page)).toBeVisible();
    await page.locator('#playChatEnabled').uncheck();
    await expect(page.locator('#loopback-chat')).toHaveCount(0);
  });

  test('is collapsed by default, under the panes and above the note', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/#/loopback');
    await enableChat(page, { publish: true, play: true });

    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle(page)).toHaveAttribute('aria-controls', 'loopback-chat-region');
    await expect(page.locator('#loopback-chat-region')).toBeHidden();
    await expect(page.locator('.data-channel-panel')).toHaveCount(2);
    await expect(page.locator('.data-channel-panel').first()).toBeHidden();

    const order = await page.evaluate(() => {
      const rect = (sel) => document.querySelector(sel).getBoundingClientRect();
      return {
        panesBottom: Math.max(...[...document.querySelectorAll('.wz-loopback__pane')]
          .map((p) => p.getBoundingClientRect().bottom)),
        bar: rect('#loopback-chat').top,
        barBottom: rect('#loopback-chat').bottom,
        note: rect('.wz-stage__note').top,
      };
    });
    expect(order.bar).toBeGreaterThanOrEqual(order.panesBottom);
    expect(order.note).toBeGreaterThanOrEqual(order.barBottom);
  });

  test('opens and closes from the keyboard, and shows each side labeled', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/#/loopback');
    await enableChat(page, { publish: true, play: true });

    await toggle(page).focus();
    await page.keyboard.press('Enter');
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('group', { name: 'Publisher chat' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Player chat' })).toBeVisible();

    // Side by side at this width.
    const tops = await page.locator('.wz-chat__side').evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().top)));
    expect(tops[0]).toBe(tops[1]);

    await page.keyboard.press('Space');
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('group', { name: 'Publisher chat' })).toBeHidden();
  });

  test('shows only the side that has chat on', async ({ page }) => {
    await page.goto('/#/loopback');
    await enableChat(page, { publish: true });
    await toggle(page).click();
    await expect(page.getByRole('group', { name: 'Publisher chat' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Player chat' })).toHaveCount(0);
  });

  for (const [name, viewport] of [['narrow', { width: 820, height: 800 }], ['stacked', { width: 390, height: 800 }]]) {
    test(`fits the ${name} layout without sideways scroll`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/#/loopback');
      await enableChat(page, { publish: true, play: true });
      await toggle(page).click();
      await expect(page.getByRole('group', { name: 'Player chat' })).toBeVisible();

      const fit = await page.evaluate(() => {
        const bar = document.querySelector('#loopback-chat').getBoundingClientRect();
        const sides = [...document.querySelectorAll('.wz-chat__side')]
          .map((el) => el.getBoundingClientRect());
        return {
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          barRight: Math.round(bar.right),
          sidesRight: Math.max(...sides.map((r) => Math.round(r.right))),
          viewport: window.innerWidth,
        };
      });
      expect(fit.pageOverflow).toBeLessThanOrEqual(0);
      expect(fit.sidesRight).toBeLessThanOrEqual(fit.barRight);
      expect(fit.barRight).toBeLessThanOrEqual(fit.viewport);
    });
  }

  test('a message sent from one panel arrives in the other', async ({ page }) => {
    await requireEngine(page, test);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto('/#/loopback');
    await enableChat(page, { publish: true, play: true });
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');

    const streamName = uniqueStream('e2eLoopChat');
    await page.getByRole('button', { name: 'Publisher', exact: true }).click();
    await startPublishing(page, { streamName });
    await expectLive(page);
    await page.getByRole('button', { name: 'Player', exact: true }).click();
    await startPlaying(page, { streamName });
    await expectPlaying(page);

    await toggle(page).click();
    const publisherPanel = page.locator('#data-channel-panel-publish');
    const playerPanel = page.locator('#data-channel-panel-play');

    const sent = `from-publisher-${Date.now()}`;
    const publisherInput = publisherPanel.locator('input.form-control');
    await expect(publisherInput).toBeEnabled({ timeout: 20_000 });
    await publisherInput.fill(sent);
    await publisherPanel.getByRole('button', { name: 'Send' }).click();
    await expect(playerPanel).toContainText(sent, { timeout: 20_000 });
    await expect(publisherPanel.locator('.chat-message-sent')).toContainText(sent);
    await expect(toggle(page)).toContainText('2 messages');

    // Collapsing keeps the log: the count stays and the messages are back on opening.
    await toggle(page).click();
    await expect(toggle(page)).toContainText('2 messages');
    await toggle(page).click();
    await expect(playerPanel).toContainText(sent);

    const reply = `from-player-${Date.now()}`;
    const playerInput = playerPanel.locator('input.form-control');
    await expect(playerInput).toBeEnabled({ timeout: 20_000 });
    await playerInput.fill(reply);
    await playerPanel.getByRole('button', { name: 'Send' }).click();
    await expect(publisherPanel).toContainText(reply, { timeout: 20_000 });
  });
});
