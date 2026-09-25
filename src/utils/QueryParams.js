/*
 * Query string reading with the built-in URLSearchParams. A repeated key yields its
 * last value, not an array; every parameter here is a single setting.
 */

/** Every parameter in the current URL, as a plain object. */
export const readQueryParams = (search = window.location.search) =>
  Object.fromEntries(new URLSearchParams(search));
