import { expect, test } from '@playwright/test';

import { requireEngine, uniqueStream } from './helpers.js';
import { expectLive, openTab, startPublishing, waitForCamera } from './ui-helpers.js';

/*
 * The publisher's Source tab: its layout at the panel's narrowest, the explainers behind the
 * info buttons, and the sender limits it sets. The layout tests need no Engine; the limit
 * tests publish to one and read the sender back.
 *
 * The limit tests only ever assert a cap downward. A cap above what the encoder would send
 * anyway changes nothing, so a "raise it" test would pass or fail on the network, not on this
 * page.
 */

const NARROWEST = 280;

const atWidth = (page, width, theme = 'dark') => page.addInitScript(([w, t]) => {
  window.localStorage.setItem('wz.inspector.width', String(w));
  window.localStorage.setItem('wz.theme', t);
}, [width, theme]);

// The pop-over is found through the button's aria-controls, which is what a screen reader uses.
const openTipOf = async (page, topic) => {
  const button = page.getByRole('button', { name: `About ${topic}`, exact: true });
  const id = await button.getAttribute('aria-controls');
  return { button, tip: page.locator(`[id="${id}"]`) };
};

test.describe('Source tab layout', () => {
  for (const width of [NARROWEST, 340]) {
    test(`fits a ${width}px panel: no horizontal scroll, no field narrower than its label`, async ({ page }) => {
      await atWidth(page, width);
      await page.goto('/#/publish');
      await openTab(page, 'Source');
      // With simulcast on the table is live, which is its widest state.
      await page.locator('#publishUseSimulcast').check();

      const read = await page.evaluate(() => {
        const body = document.querySelector('.wz-inspector__body');
        const source = [...document.querySelectorAll('#publish-settings-form > div')]
          .find((el) => !el.hidden && el.querySelector('#videoCodec'));
        const labels = [...source.querySelectorAll('label[for]')].map((label) => {
          const field = document.getElementById(label.htmlFor);
          // The label's own text width, measured without the box it happens to sit in.
          const range = document.createRange();
          range.selectNodeContents(label);
          const text = range.getBoundingClientRect().width;
          return {
            id: label.htmlFor,
            truncated: label.scrollWidth > label.clientWidth + 1,
            text: Math.ceil(text),
            field: Math.floor(field.getBoundingClientRect().width),
          };
        });
        const table = document.getElementById('simulcast-renditions').getBoundingClientRect();
        const bodyBox = body.getBoundingClientRect();
        return {
          panel: Math.round(document.querySelector('.wz-inspector').getBoundingClientRect().width),
          overflow: body.scrollWidth - body.clientWidth,
          tableInside: table.right <= bodyBox.right + 0.5,
          labels,
        };
      });

      expect(read.panel).toBe(width);
      expect(read.overflow, 'the panel scrolls sideways').toBeLessThanOrEqual(0);
      expect(read.tableInside, 'the renditions table runs past the panel').toBe(true);
      for (const label of read.labels) {
        expect(label.truncated, `${label.id} label is cut off`).toBe(false);
        // A switch is narrower than its label by design; every other field must not be.
        if (label.id === 'publishUseSimulcast') continue;
        expect(label.field, `${label.id} is narrower than its label`).toBeGreaterThanOrEqual(label.text);
      }
    });
  }

  test('keeps the ids the other suites rely on, video before audio', async ({ page }) => {
    await page.goto('/#/publish');
    await openTab(page, 'Source');
    for (const id of ['camera-list-select', 'camera-toggle', 'videoCodec', 'frameSize', 'videoFrameRate',
      'videoMaxBitrate', 'degradationPreference', 'publishUseSimulcast', 'simulcast-renditions',
      'mic-list-select', 'mute-toggle', 'audioMaxBitrate']) {
      await expect(page.locator(`#${id}`), id).toBeVisible();
    }
    const tops = await page.evaluate(() => ['videoCodec', 'videoMaxBitrate', 'degradationPreference', 'publishUseSimulcast', 'mic-list-select', 'audioMaxBitrate']
      .map((id) => document.getElementById(id).getBoundingClientRect().top));
    expect([...tops].sort((a, b) => a - b)).toEqual(tops);
  });

  test('the video cap is disabled under simulcast, and says where the caps went', async ({ page }) => {
    await page.goto('/#/publish');
    await openTab(page, 'Source');
    await expect(page.locator('#videoMaxBitrate')).toBeEnabled();
    await page.locator('#publishUseSimulcast').check();
    await expect(page.locator('#videoMaxBitrate')).toBeDisabled();
    await expect(page.locator('#videoMaxBitrate-note')).toHaveText('Set per rendition under Simulcast.');
  });

  test('an invalid cap is shown at the field and refused at Publish', async ({ page }) => {
    await page.goto('/#/publish');
    await openTab(page, 'Source');
    await page.fill('#audioMaxBitrate', '900');
    await page.locator('#audioMaxBitrate').press('Enter');
    await expect(page.locator('#audioMaxBitrate-error')).toHaveText(/from 6 to 510 kbps/);
    await page.fill('#videoMaxBitrate', '300');
    await page.locator('#videoMaxBitrate').blur();
    await expect(page.locator('#videoMaxBitrate-error')).toHaveCount(0);
  });

  test('the simulcast table reads Rendition ID, Scale down and Max (kbps), in kbps', async ({ page }) => {
    await page.goto('/#/publish');
    await openTab(page, 'Source');
    const heads = page.locator('#simulcast-renditions thead .wz-th > span:first-child');
    await expect(heads).toHaveText(['Rendition ID', 'Scale down', 'Max (kbps)']);
    await expect(page.getByRole('spinbutton', { name: 'Max kbps, rendition h' })).toHaveValue('2500');
  });

  test('each remove button names its rendition, and the limit of 3 is explained', async ({ page }) => {
    await page.goto('/#/publish');
    await openTab(page, 'Source');
    await page.locator('#publishUseSimulcast').check();
    for (const rid of ['h', 'm', 'l']) {
      await expect(page.getByRole('button', { name: `Remove rendition ${rid}`, exact: true })).toBeEnabled();
    }
    const add = page.getByRole('button', { name: /Add rendition/ });
    await expect(add).toBeDisabled();
    await expect(page.locator('#simulcast-limit-note')).toBeVisible();
    await expect(add).toHaveAccessibleDescription(/Chrome encodes at most 3 simulcast layers/);

    await page.getByRole('button', { name: 'Remove rendition l', exact: true }).click();
    await expect(add).toBeEnabled();
    await expect(page.locator('#simulcast-limit-note')).toHaveCount(0);
  });

  test('the remove button has a visible focus ring and looks disabled when it is', async ({ page }) => {
    await page.goto('/#/publish');
    await openTab(page, 'Source');
    const remove = page.getByRole('button', { name: 'Remove rendition h', exact: true });
    // Simulcast off: every row's remove is disabled.
    expect(await remove.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThan(0.6);

    await page.locator('#publishUseSimulcast').check();
    await remove.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const outline = await remove.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).toBe('solid');
  });
});

test.describe('Source tab explainers', () => {
  const topics = ['Video codec', 'Frame rate', 'Frame size', 'Max video bitrate', 'When bandwidth is short',
    'Simulcast', 'Rendition ID', 'Scale down', 'Max (kbps)', 'Max audio bitrate'];

  test('every setting has one, and the codec help is no longer a paragraph on screen', async ({ page }) => {
    await page.goto('/#/publish');
    await openTab(page, 'Source');
    for (const topic of topics) {
      await expect(page.getByRole('button', { name: `About ${topic}`, exact: true }), topic).toBeVisible();
    }
    const { tip } = await openTipOf(page, 'Video codec');
    await expect(tip).toBeHidden();
    await expect(tip).toContainText('PreferredCodecsVideo');
  });

  test('mouse over opens it, and it closes when the pointer leaves', async ({ page }) => {
    await page.goto('/#/publish');
    await openTab(page, 'Source');
    const { button, tip } = await openTipOf(page, 'Scale down');
    await button.hover();
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('1280x720 becomes 640x360');
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await page.mouse.move(5, 5);
    await expect(tip).toBeHidden();
  });

  test('keyboard focus opens it and Escape closes it, leaving focus on the button', async ({ page }) => {
    await page.goto('/#/publish');
    await openTab(page, 'Source');
    const { button, tip } = await openTipOf(page, 'Frame rate');
    await button.focus();
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('ideal');
    await page.keyboard.press('Escape');
    await expect(tip).toBeHidden();
    await expect(button).toBeFocused();
  });

  test('it is readable in light and dark: the text colour differs from its ground', async ({ page }) => {
    for (const theme of ['light', 'dark']) {
      await page.goto('/#/publish');
      await page.evaluate((t) => document.documentElement.setAttribute('data-bs-theme', t), theme);
      await openTab(page, 'Source');
      const { button, tip } = await openTipOf(page, 'Max video bitrate');
      await button.focus();
      await expect(tip).toBeVisible();
      const ratio = await tip.evaluate((el) => {
        const lum = (c) => {
          const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const cs = getComputedStyle(el);
        const a = lum(cs.color);
        const b = lum(cs.backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      expect(ratio, `${theme} contrast`).toBeGreaterThan(7);
    }
  });

  test(`is not clipped at the bottom of a scrolled ${NARROWEST}px panel`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await atWidth(page, NARROWEST);
    await page.goto('/#/publish');
    await openTab(page, 'Source');
    await page.locator('#publishUseSimulcast').check();
    await page.locator('.wz-inspector__body').evaluate((el) => { el.scrollTop = el.scrollHeight; });

    const { button, tip } = await openTipOf(page, 'Max audio bitrate');
    await button.focus();
    await expect(tip).toBeVisible();

    const where = await tip.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const points = [
        [box.left + 4, box.top + 4], [box.right - 4, box.top + 4],
        [box.left + 4, box.bottom - 4], [box.right - 4, box.bottom - 4],
      ];
      return {
        inside: box.top >= 0 && box.left >= 0 && box.bottom <= window.innerHeight && box.right <= window.innerWidth,
        // Every corner is the pop-over itself: nothing covers it and no ancestor clips it.
        onTop: points.every(([x, y]) => el.contains(document.elementFromPoint(x, y))),
      };
    });
    expect(where.inside, 'the pop-over runs off the window').toBe(true);
    expect(where.onTop, 'the pop-over is clipped or covered').toBe(true);
  });
});

/*
 * Against the Engine. Everything is read from the sender the page made, found through a
 * wrapped RTCPeerConnection.
 */
const hookConnections = (page) => page.addInitScript(() => {
  const Original = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = class extends Original {
    constructor(...args) { super(...args); window.__pcs.push(this); }
  };
});

const senderParameters = (page, kind) => page.evaluate((k) => {
  const pc = (window.__pcs || []).at(-1);
  const sender = pc && pc.getSenders().find((s) => s.track && s.track.kind === k);
  return sender ? sender.getParameters() : null;
}, kind);

/*
 * The median outbound rate over the last 3 s, once the encoder has had up to 15 s to settle
 * under the cap. Also returns the encoder's own target where Chrome reports it.
 */
const settledKbps = async (page, kind, capKbps) => {
  const samples = [];
  const start = Date.now();
  let last = null;
  while (Date.now() - start < 18_000) {
    const now = await page.evaluate(async (k) => {
      const pc = (window.__pcs || []).at(-1);
      let bytes = 0;
      let target = null;
      (await pc.getStats()).forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === k) {
          bytes += r.bytesSent || 0;
          if (r.targetBitrate != null) target = (target || 0) + r.targetBitrate;
        }
      });
      return { at: performance.now(), bytes, target };
    }, kind);
    if (last) samples.push({ at: now.at, kbps: ((now.bytes - last.bytes) * 8) / (now.at - last.at), target: now.target });
    last = now;

    const recent = samples.filter((s) => now.at - s.at <= 3000);
    if (Date.now() - start > 4000 && recent.length >= 5) {
      const sorted = recent.map((s) => s.kbps).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (median <= capKbps * 1.1) return { median, target: now.target, samples: samples.length };
    }
    await page.waitForTimeout(500);
  }
  const recent = samples.slice(-6).map((s) => s.kbps).sort((a, b) => a - b);
  return { median: recent[Math.floor(recent.length / 2)], target: last?.target ?? null, samples: samples.length };
};

const noErrorBanner = (page) => expect(page.locator('#error-messages')).toHaveCount(0);

test.describe('Source tab limits on a live publish', () => {
  test('caps video at 300 kbps and audio at 16 kbps, and sets the bandwidth preference', async ({ page, browserName }) => {
    await hookConnections(page);
    await page.goto('/#/publish');
    await requireEngine(page, test);
    await waitForCamera(page);

    await openTab(page, 'Source');
    await page.fill('#videoMaxBitrate', '300');
    await page.locator('#videoMaxBitrate').press('Enter');
    await page.fill('#audioMaxBitrate', '16');
    await page.locator('#audioMaxBitrate').press('Enter');
    await page.selectOption('#degradationPreference', 'maintain-framerate');
    await openTab(page, 'Connection');

    await startPublishing(page, { streamName: uniqueStream('e2eCap') });
    await expectLive(page);

    await expect.poll(async () => (await senderParameters(page, 'video'))?.encodings?.[0]?.maxBitrate).toBe(300000);
    await expect.poll(async () => (await senderParameters(page, 'audio'))?.encodings?.[0]?.maxBitrate).toBe(16000);
    if (browserName === 'chromium') {
      expect((await senderParameters(page, 'video')).degradationPreference).toBe('maintain-framerate');
    }

    const video = await settledKbps(page, 'video', 300);
    expect(video.median, `video settled at ${video.median} kbps`).toBeLessThanOrEqual(330);
    if (video.target != null) expect(video.target).toBeLessThanOrEqual(300_000);

    const audio = await settledKbps(page, 'audio', 16);
    expect(audio.median, `audio settled at ${audio.median} kbps`).toBeLessThanOrEqual(18);

    await noErrorBanner(page);
  });

  test('edits while live apply, two quick ones in a row included, with no InvalidModificationError', async ({ page }) => {
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await hookConnections(page);
    await page.goto('/#/publish');
    await requireEngine(page, test);
    await startPublishing(page, { streamName: uniqueStream('e2eLiveCap') });
    await expectLive(page);

    await openTab(page, 'Source');
    // Locked fields keep their explainers.
    await expect(page.locator('#videoCodec')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'About Video codec', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'About Rendition ID', exact: true })).toBeEnabled();

    await page.fill('#videoMaxBitrate', '400');
    await page.locator('#videoMaxBitrate').press('Enter');
    await page.fill('#videoMaxBitrate', '250');
    await page.locator('#videoMaxBitrate').press('Enter');
    await page.selectOption('#degradationPreference', 'maintain-resolution');
    await page.fill('#audioMaxBitrate', '24');
    await page.locator('#audioMaxBitrate').press('Enter');

    await expect.poll(async () => (await senderParameters(page, 'video'))?.encodings?.[0]?.maxBitrate).toBe(250000);
    await expect.poll(async () => (await senderParameters(page, 'video'))?.degradationPreference).toBe('maintain-resolution');
    await expect.poll(async () => (await senderParameters(page, 'audio'))?.encodings?.[0]?.maxBitrate).toBe(24000);

    // Cleared is no cap at all, not a cap of zero.
    await page.fill('#videoMaxBitrate', '');
    await page.locator('#videoMaxBitrate').press('Enter');
    await expect.poll(async () => (await senderParameters(page, 'video'))?.encodings?.[0]?.maxBitrate ?? null).toBeNull();

    await noErrorBanner(page);
    expect(errors.filter((e) => /InvalidModification|setParameters/i.test(e))).toEqual([]);
  });

  test('a simulcast rung takes a live kbps edit', async ({ page }) => {
    await hookConnections(page);
    await page.goto('/#/publish');
    await requireEngine(page, test);
    await waitForCamera(page);
    await openTab(page, 'Source');
    await page.locator('#publishUseSimulcast').check();
    await openTab(page, 'Connection');
    await startPublishing(page, { streamName: uniqueStream('e2eRungCap') });
    await expectLive(page);

    const byRid = async () => Object.fromEntries(((await senderParameters(page, 'video'))?.encodings || [])
      .map((e) => [e.rid, e.maxBitrate]));
    await expect.poll(byRid).toEqual({ h: 2500000, m: 700000, l: 200000 });

    await openTab(page, 'Source');
    const m = page.getByRole('spinbutton', { name: 'Max kbps, rendition m' });
    await expect(m).toBeEnabled();
    await m.fill('300');
    await m.press('Enter');
    const h = page.getByRole('spinbutton', { name: 'Max kbps, rendition h' });
    await h.fill('1500');
    await h.press('Enter');

    await expect.poll(byRid).toEqual({ h: 1500000, m: 300000, l: 200000 });
    await noErrorBanner(page);
  });
});
