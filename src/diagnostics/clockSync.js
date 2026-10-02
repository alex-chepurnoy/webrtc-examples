/*
 * Bounds how far a second machine's clock sits from this one, NTP style. Only needed when
 * publisher and player are on different machines.
 *
 * Every exchange gives an interval the offset is certain to lie in, whatever the path looks
 * like. With theta the far clock minus this one, and both one-way delays d >= 0:
 *
 *   t1 = t0 + theta + d_forward   so   theta = (t1 - t0) - d_forward  <=  t1 - t0
 *   t3 = t2 - theta + d_reverse   so   theta = (t2 - t3) + d_reverse  >=  t2 - t3
 *
 * The interval [t2 - t3, t1 - t0] is as wide as the round trip with the far end's turnaround
 * taken out, and this holds for ANY split between the two directions. Asymmetry decides only
 * where in the interval the truth sits, and nothing seen from one machine can say where.
 * Halving a round trip is the midpoint of that interval, not a measurement of the split.
 *
 * Intervals from several samples are intersected. The tightest upper bound and the tightest
 * lower bound may come from different samples, so the result is never wider than the fastest
 * round trip and is usually narrower. The estimate is the midpoint, which minimizes the worst
 * case, and half the width is the reported bound.
 *
 * Local scheduling cannot corrupt it: a busy thread stamps t1 or t3 late, or delays a send
 * after t0 or t2, and each of those only loosens a bound. Nothing here ever refuses on width.
 * A long path gives a wide range, and the caller shows it.
 *
 * What the bound assumes, and says so wherever it is shown: stable clocks, meaning no step and
 * no slew above RHO inside the window. Drift inside that rate is widened for; a step larger
 * than the sample intervals is detected and the older samples dropped; a step smaller than the
 * intervals leaves a non-empty intersection that excludes the truth and is NOT detected, with
 * an excess error of roughly the size of the step.
 */

/*
 * Samples older than this, measured against the newest on a monotonic clock, do not count. A
 * window by time rather than by count, so a faster ping cadence does not shorten the memory.
 */
export const WINDOW_MS = 20_000;

/* A cap on the window, well above what 20 s holds at the 1 s cadence. */
export const WINDOW_SAMPLES = 32;

/*
 * Each sample's interval is a bound on its own, so a handful is enough to show a range.
 * Eight were once needed because one sample stood alone as the whole estimate.
 */
export const MIN_SAMPLES = 3;

/* The consistent samples at which the ping cadence slows from fast to slow. */
export const SETTLED_SAMPLES = 8;

/*
 * Date.now() is whole milliseconds and browsers coarsen timers further. Used only to
 * classify a loopback path as one clock (see describeClock), where rounding alone must not
 * keep it from reading as exact.
 */
export const CLOCK_GRANULARITY_MS = 2;

/*
 * Date.now() floors, so each of t0 to t3 can be up to 1 ms early on its own machine. Every
 * interval is padded by this on each side, and the transport display adds it once more
 * (sentAt and arrivedAt are floored independently). The probe is Chromium only, where the
 * resolution is 1 ms, so it is not measured at startup.
 */
export const TIMER_RESOLUTION_MS = 1;

/*
 * The largest relative clock rate difference the bound allows for. An assumption, not a
 * measurement: crystal oscillators sit within tens of ppm, and NTP slews at up to 500 ppm, so
 * 250 ppm covers ordinary drift and a gentle slew. A step, or a correction at the full slew
 * rate, is outside it.
 */
export const DRIFT_RATE = 250e-6;

/*
 * A bound wider than this is still shown, with a hint that the path is long. It colors the
 * wording and never withholds a figure.
 */
export const WIDE_RANGE_MS = 30;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/*
 * t0 sent, t1 received by the far end, t2 replied by the far end, t3 reply received, m3 the
 * monotonic reading (performance.now) taken with t3. Ages come from m3 and not from t3,
 * because a step of this machine's wall clock would corrupt an age taken from t3; samples
 * without it (older callers, tests) fall back to t3.
 *
 * Returns the interval before drift is added, and the elapsed time on this machine's clock
 * (round trip plus the far end's turnaround) that drift also widens it by.
 */
const measure = (sample) => {
  if (!sample) return null;
  const { t0, t1, t2, t3 } = sample;
  if (![t0, t1, t2, t3].every(isFiniteNumber)) return null;

  const localElapsed = t3 - t0;
  const farTurnaround = t2 - t1;

  /*
   * Each leg is checked on its own: either one running backwards is a clock that moved
   * mid-sample, and the combined round trip can hide it as a plausible positive value.
   */
  if (localElapsed < 0 || farTurnaround < 0) return null;

  /*
   * The floors can make a truthful loopback sample read a round trip of -1 or -2 ms. Those are
   * kept: dropping them would keep only the positively rounded samples and quietly tighten the
   * result. Anything more negative than the rounding allows is a clock that moved.
   */
  const rtt = localElapsed - farTurnaround;
  if (rtt < -2 * TIMER_RESOLUTION_MS) return null;

  return {
    rtt: Math.max(0, rtt),
    lo: t2 - t3 - TIMER_RESOLUTION_MS,
    hi: t1 - t0 + TIMER_RESOLUTION_MS,
    elapsed: localElapsed,
    mono: isFiniteNumber(sample.m3) ? sample.m3 : t3,
  };
};

/* The usable samples inside the window, oldest first, anchored on the newest. */
const windowed = (samples) => {
  if (!Array.isArray(samples)) return [];
  const usable = samples.slice(-WINDOW_SAMPLES).map(measure).filter((m) => m !== null);
  if (usable.length === 0) return usable;
  const newest = usable[usable.length - 1].mono;
  return usable.filter((m) => newest - m.mono <= WINDOW_MS);
};

/** How many of the samples in the window can be used, which is what MIN_SAMPLES counts. */
export const countUsableSamples = (samples) => windowed(samples).length;

const NO_ANSWER = {
  usable: 0,
  samples: 0,
  offsetMs: null,
  uncertaintyMs: null,
  ageMs: null,
  stepAgeMs: null,
};

/**
 * Everything the samples support, oldest first, as a pure function of the list.
 *
 *   usable        samples in the window
 *   samples       the consistent ones, newest back to the first that disagrees
 *   offsetMs      midpoint of the intersection, or null when fewer than MIN_SAMPLES agree
 *   uncertaintyMs half the intersection plus the drift since the newest sample
 *   ageMs         time since the newest sample, given `monoNow` (performance.now())
 *   stepAgeMs     how far back the walk broke, or null when every sample in the window agreed
 *
 * The walk goes newest first, intersecting, and stops at the first sample that would empty the
 * intersection. Older samples are from before whatever moved. Each sample is widened by the
 * drift allowance for its age and for its own duration. The duration is the whole exchange, not
 * only the round trip, because the derivation holds one offset across t0 to t3 and the offset
 * moves while a frozen or throttled tab holds a reply for seconds.
 */
export const estimateClock = (samples, { monoNow = null } = {}) => {
  const inWindow = windowed(samples);
  if (inWindow.length === 0) return NO_ANSWER;

  const newest = inWindow[inWindow.length - 1];
  let upper = Infinity;
  let lower = -Infinity;
  let consistent = 0;
  let stepAgeMs = null;

  for (let i = inWindow.length - 1; i >= 0; i -= 1) {
    const m = inWindow[i];
    const age = Math.max(0, newest.mono - m.mono);
    const slack = DRIFT_RATE * (age + m.elapsed);
    const nextUpper = Math.min(upper, m.hi + slack);
    const nextLower = Math.max(lower, m.lo - slack);
    // The padding is already in each side, so any gap at all is a disagreement.
    if (nextLower > nextUpper) {
      stepAgeMs = age;
      break;
    }
    upper = nextUpper;
    lower = nextLower;
    consistent += 1;
  }

  const ageMs = isFiniteNumber(monoNow) ? Math.max(0, monoNow - newest.mono) : null;
  const answer = {
    usable: inWindow.length,
    samples: consistent,
    offsetMs: null,
    uncertaintyMs: null,
    ageMs,
    stepAgeMs,
  };
  if (consistent < MIN_SAMPLES) return answer;

  return {
    ...answer,
    offsetMs: (upper + lower) / 2,
    // A silent channel widens the bound smoothly instead of freezing it.
    uncertaintyMs: (upper - lower) / 2 + DRIFT_RATE * (ageMs ?? 0),
  };
};

/**
 * The offset and its bound, or null when fewer than MIN_SAMPLES consistent samples exist.
 * Render null as "cannot measure yet", never as zero: zero is a legitimate same-machine offset.
 * The bound already includes the resolution of the readings it came from.
 */
export const estimateOffset = (samples, options) => {
  const estimate = estimateClock(samples, options);
  return estimate.offsetMs === null ? null : estimate;
};
