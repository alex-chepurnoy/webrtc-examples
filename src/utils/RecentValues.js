/*
 * Recently used signaling URLs, application names and stream names: per field, most recent
 * first, offered as suggestions. Signaling URLs are also kept per transport.
 * Never the auth token, TURN password or client IP: no credentials in local storage.
 */

const PREFIX = 'wz.recent.';
const LIMIT = 8;

const key = (field, scope) => `${PREFIX}${field}${scope ? `.${scope}` : ''}`;

const read = (storageKey) => {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    // Blocked or corrupted storage: no suggestions is a fine outcome.
    return [];
  }
};

const write = (storageKey, values) => {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(values));
  } catch {
    // Not remembering is not a reason to fail the thing the user actually asked for.
  }
};

export const readRecent = (field, scope = null) => read(key(field, scope));

/**
 * Most recent first, no duplicates, capped. Blank values are not worth remembering, and
 * neither is a signaling URL written for the other transport: it would be offered back
 * where it cannot work.
 */
export const rememberValue = (field, value, scope = null) => {
  const text = String(value ?? '').trim();
  if (text === '') return readRecent(field, scope);
  if (field === 'signalingURL' && scope) {
    const written = transportOf(text);
    if (written !== null && written !== scope) return readRecent(field, scope);
  }

  const next = [text, ...readRecent(field, scope).filter((v) => v !== text)].slice(0, LIMIT);
  write(key(field, scope), next);
  return next;
};

/** Drop one remembered value, for the button beside it in the suggestion list. */
export const forgetValue = (field, value, scope = null) => {
  const next = readRecent(field, scope).filter((v) => v !== value);
  write(key(field, scope), next);
  return next;
};

