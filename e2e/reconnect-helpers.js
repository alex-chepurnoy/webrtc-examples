import { expect } from '@playwright/test';

/*
 * Helpers for the reconnect suites: a man in the middle on the signaling socket, so a test
 * can do to a live session what an Engine or application restart does, and the panel rows
 * the page writes when it notices.
 *
 * The session socket and the liveness check's socket are told apart by their query strings:
 * the session opens ?webrtcImplementation=v2, the check adds &wzProbe=liveness.
 */

export const SESSION_SOCKET = /webrtc-session\.json\?webrtcImplementation=v2$/;
export const PROBE_SOCKET = /webrtc-session\.json\?[^#]*wzProbe=liveness/;

/** Shortens the reconnect timings for this page. Must run before the page loads. */
export const useTimings = (page, timings) =>
  page.addInitScript((value) => { window.__wzReconnectTimings = value; }, timings);

/**
 * Relays every session socket to the Engine and records what goes through. Returns controls:
 *   closeFromServer(code, reason)  close the newest socket as a server would
 *   dropIceRestart                 when true, ICE_RESTART frames never reach the Engine
 *   hold                           when true, new sockets open but are never answered
 *   counts                         frames the page sent, by messageType
 */
export const relaySessions = async (page) => {
  const control = {
    sockets: [],
    counts: {},
    dropIceRestart: false,
    hold: false,
    closeFromServer: async (code, reason) => {
      const newest = control.sockets[control.sockets.length - 1];
      if (!newest) throw new Error('No session socket to close.');
      await newest.page.close({ code, reason });
      if (newest.server) await newest.server.close().catch(() => {});
    },
  };

  await page.routeWebSocket(SESSION_SOCKET, (ws) => {
    const entry = { page: ws, server: null };
    control.sockets.push(entry);
    if (!control.hold) {
      entry.server = ws.connectToServer();
      entry.server.onMessage((message) => ws.send(message));
      entry.server.onClose((code, reason) => ws.close({ code, reason }).catch(() => {}));
    }
    ws.onMessage((message) => {
      let type = 'text';
      try { type = JSON.parse(message).messageType || 'unknown'; } catch { /* not JSON */ }
      control.counts[type] = (control.counts[type] || 0) + 1;
      if (!entry.server) return;
      if (type === 'ICE_RESTART' && control.dropIceRestart) return;
      entry.server.send(message);
    });
  });

  return control;
};

/**
 * Answers the liveness check. While `missing` is false it goes to the Engine as usual; set it
 * and the stream is reported gone, which is what the check sees after an application restart.
 * `refuse` answers with an error status instead, as an Engine with stream query off does.
 */
export const answerProbe = async (page, streamName) => {
  const control = { missing: false, refuse: null, asked: 0 };
  await page.routeWebSocket(PROBE_SOCKET, (ws) => {
    control.asked += 1;
    if (control.refuse) {
      ws.onMessage(() => ws.send(JSON.stringify(control.refuse)));
      return;
    }
    if (control.missing) {
      ws.onMessage(() => ws.send(JSON.stringify({
        statusCode: 200,
        availableStreams: [{ streamName: `not${streamName}` }],
      })));
      return;
    }
    ws.connectToServer();
  });
  return control;
};

/** Opens the server communication panel, whose rows these suites read. */
export const openPanel = async (page) => {
  const toggle = page.getByRole('button', { name: /Server communication/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
};

/** One panel row by its level (in, out, info, warn, error) and a label fragment or pattern. */
export const panelRow = (page, level, text) =>
  page.locator(`.wz-debug__row--${level} .wz-debug__label`, { hasText: text });

export const expectRow = async (page, level, text, timeout = 30_000) =>
  expect(panelRow(page, level, text).first()).toBeAttached({ timeout });

/**
 * Counts the WHIP or WHEP POSTs a page makes, and the DELETEs of their resources. The Engine
 * names a resource by the same path with ?connectionId=, so both are keyed on the suffix.
 */
export const countPosts = (page, suffix) => {
  const posts = { count: 0, deletes: 0 };
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (!path.endsWith(suffix)) return;
    if (request.method() === 'POST') posts.count += 1;
    if (request.method() === 'DELETE') posts.deletes += 1;
  });
  return posts;
};

/** The resource URL of a WHIP or WHEP session: the endpoint with a query naming the connection. */
export const RESOURCE = (suffix) => new RegExp(`${suffix}\\?connectionId=`);
