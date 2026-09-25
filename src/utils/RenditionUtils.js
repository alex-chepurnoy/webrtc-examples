/*
 * Simulcast renditions, as the Engine exposes them. The Engine republishes each rendition
 * as its own stream: the first keeps the published name, the rest get "_<rid>" appended
 * (rids h/m/l give "name", "name_m", "name_l"). Choosing a rendition is choosing a stream name.
 */

import { SIGNALING_PATH, isHostless } from './SignalingUrlUtils';
import { DEFAULT_SIMULCAST_RENDITIONS } from './SimulcastUtils';

export const RENDITION_SEPARATOR = '_';

/**
 * The WebSocket URL for a stream lookup, from the Signaling URL field. Under WHEP the field
 * holds an https origin; the same host serves the signaling endpoint. Returns null when
 * nothing usable can be derived.
 */
export const signalingLookupUrl = (signalingURL) => {
  const text = String(signalingURL || '').trim();

  // new URL('wss:///webrtc-session.json') reads the path segment as the host.
  if (isHostless(text)) return null;

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }

  if (!parsed.host) return null;

  if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') return text;

  if (parsed.protocol === 'https:') return `wss://${parsed.host}${SIGNALING_PATH}`;
  if (parsed.protocol === 'http:') return `ws://${parsed.host}${SIGNALING_PATH}`;

  return null;
};

/*
 * The rids a player can take for rendition suffixes. The player cannot see the publisher's
 * ladder, so these are the default ladder (h, m, l, highest first) plus any the caller knows
 * of, such as the rids configured on this page's own publisher. Any other "_suffix" is part
 * of a stream's own name: with "camera" and "camera_north" both live, camera_north is a
 * second camera, not a rendition "north" of the first.
 */
const LADDER = DEFAULT_SIMULCAST_RENDITIONS.map((r) => r.rid);

const knownRidSet = (extraRids) => new Set([
  ...LADDER,
  ...(Array.isArray(extraRids) ? extraRids.filter((rid) => typeof rid === 'string' && rid !== '') : []),
]);

/**
 * The published name behind a possibly rendition-suffixed one. Strips only a known rid, and
 * only when the result is itself live, so "camera_north" is left alone.
 */
export const baseStreamName = (streamName, streams, extraRids) => {
  const name = String(streamName || '');
  const index = name.lastIndexOf(RENDITION_SEPARATOR);
  if (index <= 0) return name;

  if (!knownRidSet(extraRids).has(name.slice(index + 1))) return name;

  const stripped = name.slice(0, index);
  const list = Array.isArray(streams) ? streams : [];
  return list.includes(stripped) ? stripped : name;
};

// Default-ladder rids keep that order, highest first; any others follow alphabetically.
const byLadder = (a, b) => {
  const ia = LADDER.indexOf(a.rid);
  const ib = LADDER.indexOf(b.rid);
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
  return a.rid.localeCompare(b.rid);
};

/**
 * Every rendition of one published stream, source first. Returns [] when the stream is not
 * live or has no rendition siblings. `extraRids` adds rids beyond the default ladder.
 */
export const renditionsFor = (streamName, streams, extraRids) => {
  const list = Array.isArray(streams) ? streams.filter((s) => typeof s === 'string') : [];
  const base = baseStreamName(streamName, list, extraRids);
  if (base === '' || !list.includes(base)) return [];

  const known = knownRidSet(extraRids);
  const prefix = base + RENDITION_SEPARATOR;
  const variants = list
    .filter((s) => s.startsWith(prefix) && known.has(s.slice(prefix.length)))
    .map((s) => ({ value: s, rid: s.slice(prefix.length) }))
    .sort(byLadder);

  if (variants.length === 0) return [];

  return [
    { value: base, label: 'Source (highest rendition)' },
    ...variants.map((v) => ({ value: v.value, label: `Rendition "${v.rid}"` })),
  ];
};

/*
 * What a lookup found. The three failures read differently to the person at the page:
 *   unreachable  no answer at all (wrong host or port, certificate, Engine down)
 *   error        the Engine answered, with an error (unknown application, refused)
 *   ok           a list, which is [] for an application with nothing live on it
 */
export const LOOKUP_OK = 'ok';
export const LOOKUP_ERROR = 'error';
export const LOOKUP_UNREACHABLE = 'unreachable';

/** Reads one reply frame. Exported for tests. */
export const readAvailableStreamsReply = (parsed) => {
  if (!parsed || typeof parsed !== 'object') {
    return { status: LOOKUP_ERROR, message: null };
  }
  const code = parsed.statusCode === undefined ? null : Number(parsed.statusCode);
  if (code !== null && code !== 200) {
    return { status: LOOKUP_ERROR, code, message: parsed.statusDescription || null };
  }
  if (Array.isArray(parsed.availableStreams)) {
    return {
      status: LOOKUP_OK,
      streams: parsed.availableStreams
        .map((entry) => (typeof entry === 'string' ? entry : entry?.streamName))
        .filter((name) => typeof name === 'string'),
    };
  }
  // An application with nothing live answers with availableStreams null (the v1 example
  // handled the same case), which is an empty list, not a failure.
  if ((Object.prototype.hasOwnProperty.call(parsed, 'availableStreams') && parsed.availableStreams == null)
      || code === 200) {
    return { status: LOOKUP_OK, streams: [] };
  }
  return { status: LOOKUP_ERROR, message: parsed.statusDescription || null };
};

/**
 * Asks the Engine which streams are live on an application, on its own short-lived socket
 * so it cannot disturb a session. Resolves to { status, streams?, code?, message? }.
 */
export const listAvailableStreams = (signalingURL, applicationName, timeoutMs = 6000) =>
  new Promise((resolve) => {
    let settled = false;
    let opened = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // Opened and then silent is an Engine that did not answer, not one that cannot be reached.
    const noAnswer = () => (opened
      ? { status: LOOKUP_ERROR, message: 'The Engine accepted the connection but did not answer.' }
      : { status: LOOKUP_UNREACHABLE });

    let socket;
    try {
      socket = new WebSocket(signalingURL);
    } catch {
      return done({ status: LOOKUP_UNREACHABLE });
    }

    const timer = setTimeout(() => {
      try { socket.close(); } catch { /* already closing */ }
      done(noAnswer());
    }, timeoutMs);

    const finish = (value) => {
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closing */ }
      done(value);
    };

    socket.onopen = () => {
      opened = true;
      socket.send(JSON.stringify({ messageType: 'GET_AVAILABLE_STREAMS', applicationName }));
    };

    socket.onmessage = (event) => {
      try {
        finish(readAvailableStreamsReply(JSON.parse(event.data)));
      } catch {
        finish({ status: LOOKUP_ERROR, message: 'The reply was not one this page can read.' });
      }
    };

    socket.onerror = () => finish(noAnswer());
    socket.onclose = () => finish(noAnswer());
  });
