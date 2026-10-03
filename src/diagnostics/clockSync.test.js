import { describe, expect, it } from 'vitest';

import {
  DRIFT_RATE,
  MIN_SAMPLES,
  TIMER_RESOLUTION_MS,
  WINDOW_MS,
  WINDOW_SAMPLES,
  countUsableSamples,
  estimateClock,
  estimateOffset,
} from './clockSync';

/*
 * One round trip against a far end whose clock is offsetMs ahead of ours, in exact arithmetic
 * (no flooring). forwardShare is the outbound leg's share of the round trip (0.5 is
 * symmetric). The far end replies instantly unless turnaroundMs says otherwise.
 */
const roundTrip = ({
  offsetMs = 0, rttMs = 20, forwardShare = 0.5, t0 = 1_000_000, turnaroundMs = 0,
} = {}) => {
  const t1 = t0 + rttMs * forwardShare + offsetMs;
  return { t0, t1, t2: t1 + turnaroundMs, t3: t0 + rttMs + turnaroundMs };
};

const repeat = (count, make) => Array.from({ length: count }, (_unused, i) => make(i));

/* Samples one second apart, so the window keeps them and ages are known. */
const series = (count, make, { start = 1_000_000, step = 1_000 } = {}) =>
  repeat(count, (i) => roundTrip({ ...make(i), t0: start + i * step }));

const R = TIMER_RESOLUTION_MS;

describe('estimateOffset', () => {
  it('recovers an offset that was injected on purpose', () => {
    const rtts = [40, 60, 25, 80, 55, 30, 95, 45, 70, 35];
    const estimate = estimateOffset(
      series(rtts.length, (i) => ({ offsetMs: 137, rttMs: rtts[i] })),
    );

    expect(estimate.offsetMs).toBeCloseTo(137, 6);
    // Intersection of intervals each as wide as its round trip: never wider than the fastest
    // (25 ms) plus the padding, and here exactly that because the paths are symmetric.
    expect(estimate.uncertaintyMs).toBeGreaterThanOrEqual(12.5 + R);
    // Older samples are widened for their age (up to 9 s here), which is the only slack.
    expect(estimate.uncertaintyMs).toBeLessThan(12.5 + R + DRIFT_RATE * 10_000);
    expect(estimate.samples).toBe(10);
  });

  // The intersection is narrower than any single sample when the extremes come from different
  // samples: one forward-fast, one reverse-fast. The old best-single-sample estimate could not.
  it('is tighter than the fastest single round trip when two samples bound opposite sides', () => {
    // theta is 100. Sample A: forward 2, reverse 38 (rtt 40). Sample B: forward 38, reverse 2.
    const a = { t0: 0, t1: 102, t2: 102, t3: 40 };
    const b = { t0: 1_000, t1: 1_138, t2: 1_138, t3: 1_040 };
    const estimate = estimateOffset([a, b, { ...a, t0: 2_000, t1: 2_102, t2: 2_102, t3: 2_040 }]);

    // A alone is [62, 102]; B alone is [98, 138]. Together [98, 102], 4 ms wide plus padding.
    expect(Math.abs(estimate.offsetMs - 100)).toBeLessThan(0.5);
    expect(estimate.uncertaintyMs).toBeLessThan(2 + R + 1);
  });

  // The interval holds for any split of the round trip: asymmetry moves the estimate, not the
  // truth out of the range.
  it('holds the truth inside the bound for every split of the round trip', () => {
    for (const forwardShare of [0, 0.1, 0.5, 0.9, 1]) {
      const estimate = estimateOffset(
        series(8, () => ({ offsetMs: 300, rttMs: 100, forwardShare })),
      );
      expect(Math.abs(estimate.offsetMs - 300)).toBeLessThanOrEqual(estimate.uncertaintyMs);
    }
  });

  /*
   * The undetectable error, pinned so the bound is not mistaken for measured accuracy: a
   * constant 90/10 split on a 100 ms path puts the midpoint 40 ms off, which is half the
   * asymmetry (80 ms), and inside the 50 ms half-width.
   */
  it('is wrong by half the asymmetry, silently, within its bound', () => {
    const skewed = series(8, () => ({ offsetMs: 0, rttMs: 100, forwardShare: 0.9 }));

    const estimate = estimateOffset(skewed);
    expect(estimate.offsetMs).toBeCloseTo(40, 6);
    expect(estimate.uncertaintyMs).toBeCloseTo(50 + R, 1);
    expect(Math.abs(estimate.offsetMs)).toBeLessThanOrEqual(estimate.uncertaintyMs);
  });

  // The old design refused above 58 ms; a long path now gives a wide range and an answer.
  it('answers over a 500 ms round trip with a wide range, never a refusal', () => {
    const estimate = estimateOffset(series(10, () => ({ offsetMs: 5_000, rttMs: 500 })));
    expect(estimate).not.toBeNull();
    expect(estimate.offsetMs).toBeCloseTo(5_000, 6);
    expect(estimate.uncertaintyMs).toBeGreaterThan(250);
    expect(estimate.uncertaintyMs).toBeLessThan(250 + R + 1);
  });

  it('counts the usable samples, which is what the minimum applies to', () => {
    const junk = repeat(5, () => null);
    expect(countUsableSamples([...junk, ...series(3, () => ({}))])).toBe(3);
    expect(countUsableSamples(null)).toBe(0);
  });

  describe('before there is a range', () => {
    it('returns null below the minimum, and a range from the minimum on', () => {
      expect(estimateOffset(series(MIN_SAMPLES - 1, () => ({})))).toBeNull();
      expect(estimateOffset(series(MIN_SAMPLES, () => ({})))).not.toBeNull();
    });

    it('returns null on nothing at all', () => {
      expect(estimateOffset([])).toBeNull();
      expect(estimateOffset(null)).toBeNull();
      expect(estimateOffset(undefined)).toBeNull();
    });
  });

  describe('a clock that moved', () => {
    // 15 s on one offset, then the far clock steps 2 s. The old samples cannot all be right.
    const stepped = (after) => [
      ...series(15, () => ({ offsetMs: 0, rttMs: 10 }), { start: 1_000_000 }),
      ...series(after, () => ({ offsetMs: 2_000, rttMs: 10 }), { start: 1_015_000 }),
    ];

    it('is detected, and the estimate comes from the samples after the step', () => {
      const estimate = estimateClock(stepped(5));

      expect(estimate.stepAgeMs).not.toBeNull();
      expect(estimate.samples).toBe(5);
      expect(estimate.offsetMs).toBeCloseTo(2_000, 6);
      expect(Math.abs(estimate.offsetMs - 2_000)).toBeLessThanOrEqual(estimate.uncertaintyMs);
    });

    // Two samples after the step are too few to stand behind: a short suffix is a re-sync, not
    // a number.
    it('gives no range while fewer than the minimum samples agree after the step', () => {
      const estimate = estimateClock(stepped(MIN_SAMPLES - 1));
      expect(estimate.offsetMs).toBeNull();
      expect(estimate.stepAgeMs).not.toBeNull();
      expect(estimate.samples).toBe(MIN_SAMPLES - 1);
      expect(estimate.usable).toBeGreaterThan(MIN_SAMPLES);
    });

    it('reports no step when every sample agrees', () => {
      expect(estimateClock(series(20, () => ({ offsetMs: 40, rttMs: 30 }))).stepAgeMs).toBeNull();
    });

    // A backward step of the LOCAL wall clock must not corrupt ages: they come from m3.
    it('takes ages from the monotonic reading, not from the wall clock', () => {
      const samples = series(10, () => ({ offsetMs: 0, rttMs: 10 }))
        .map((sample, i) => ({ ...sample, m3: 50_000 + i * 1_000 }));
      // The wall clock of the last two samples jumped forward an hour; the intervals are still
      // consistent because only t0 and t3 moved together.
      const jumped = samples.map((sample, i) => (i < 8 ? sample : {
        ...sample, t0: sample.t0 + 3_600_000, t3: sample.t3 + 3_600_000,
        t1: sample.t1 + 3_600_000, t2: sample.t2 + 3_600_000,
      }));

      const estimate = estimateClock(jumped);
      expect(estimate.usable).toBe(10);
      expect(estimate.stepAgeMs).toBeNull();
    });
  });

  describe('time and age', () => {
    it('forgets samples older than the window', () => {
      const stale = roundTrip({ offsetMs: 999, rttMs: 2, t0: 1_000_000 });
      const recent = series(10, () => ({ offsetMs: 20, rttMs: 50 }),
        { start: 1_000_000 + WINDOW_MS + 5_000 });

      const estimate = estimateOffset([stale, ...recent]);
      expect(estimate.offsetMs).toBeCloseTo(20, 6);
      expect(estimate.samples).toBe(10);
      // Outside the window is forgetting, not a disagreement.
      expect(estimate.stepAgeMs).toBeNull();
    });

    it('caps the window by count as well', () => {
      const estimate = estimateOffset(series(WINDOW_SAMPLES + 20, () => ({ rttMs: 10 }), { step: 10 }));
      expect(estimate.samples).toBe(WINDOW_SAMPLES);
    });

    // A dead clock channel degrades the bound smoothly instead of freezing it.
    it('widens the bound by the drift allowance for the time since the newest sample', () => {
      const samples = series(8, () => ({ offsetMs: 10, rttMs: 20 }));
      const newestM3 = samples[samples.length - 1].t3;

      const fresh = estimateOffset(samples, { monoNow: newestM3 });
      const silent = estimateOffset(samples, { monoNow: newestM3 + 60_000 });

      expect(silent.ageMs).toBe(60_000);
      expect(silent.uncertaintyMs - fresh.uncertaintyMs).toBeCloseTo(DRIFT_RATE * 60_000, 6);
      expect(silent.offsetMs).toBe(fresh.offsetMs);
    });

    // An old sample is widened for its age, so it cannot hold the answer tighter than it should.
    it('widens each older sample by the drift over its age', () => {
      const a = roundTrip({ offsetMs: 0, rttMs: 0, t0: 1_000_000 });
      const samples = [a, ...series(2, () => ({ offsetMs: 0, rttMs: 40 }), { start: 1_018_000 })];

      // Alone the 19 s old zero-rtt sample would give a half-width of R. Widened by 250 ppm
      // over 19 s it is R + 4.75 ms, and the two fresh 40 ms samples are intersected with it.
      const estimate = estimateOffset(samples);
      expect(estimate.uncertaintyMs).toBeGreaterThan(R + 4);
      expect(estimate.uncertaintyMs).toBeLessThan(R + 6);
    });

    // A frozen publisher tab can hold a reply for seconds, during which its clock keeps running.
    it('widens a sample by the drift over the far end\'s turnaround', () => {
      const held = series(MIN_SAMPLES, () => ({ offsetMs: 0, rttMs: 0, turnaroundMs: 8_000 }));
      const prompt = series(MIN_SAMPLES, () => ({ offsetMs: 0, rttMs: 0 }));

      const widened = estimateOffset(held).uncertaintyMs;
      const tight = estimateOffset(prompt).uncertaintyMs;
      expect(widened - tight).toBeCloseTo(DRIFT_RATE * 8_000, 6);
    });
  });

  describe('samples it will not use', () => {
    // A missing or non-numeric timestamp is a dropped reply, not a measurement.
    it('drops malformed samples and counts only what it used', () => {
      const junk = [null, {}, { t0: 1, t1: 2, t2: 3 }, { t0: 1, t1: NaN, t2: 3, t3: 4 }];
      const good = series(MIN_SAMPLES, () => ({ offsetMs: 12, rttMs: 20 }));

      const estimate = estimateOffset([...junk, ...good]);
      expect(estimate.offsetMs).toBeCloseTo(12, 6);
      expect(estimate.samples).toBe(MIN_SAMPLES);
    });

    it('returns null when dropping the malformed ones leaves too few', () => {
      const junk = repeat(5, () => null);
      const good = series(MIN_SAMPLES - 1, () => ({}));
      expect(estimateOffset([...junk, ...good])).toBeNull();
    });

    // More negative than rounding allows means the local clock moved; it must not tighten
    // anything.
    it('drops a sample whose round trip came out impossibly negative', () => {
      const stepped = { t0: 1_000_100, t1: 1_000_090, t2: 1_000_095, t3: 1_000_100 };
      const good = series(MIN_SAMPLES, () => ({ offsetMs: 7, rttMs: 30 }));

      const estimate = estimateOffset([...good, stepped]);
      expect(estimate.samples).toBe(MIN_SAMPLES);
    });

    /*
     * Two floors can make a truthful loopback sample read a round trip of -1 or -2 ms. Those
     * are kept, because dropping them would keep only the samples that rounded the other way
     * and tighten the result.
     */
    it('keeps a sample whose round trip came out slightly negative from rounding', () => {
      const slightly = { t0: 1_000_000, t1: 1_000_001, t2: 1_000_001, t3: 1_000_000 };
      const minusTwo = { t0: 1_001_000, t1: 1_001_002, t2: 1_001_004, t3: 1_001_001 };
      const estimate = estimateOffset([slightly, minusTwo, ...series(MIN_SAMPLES, () => ({ rttMs: 4 }))]);
      expect(estimate.samples).toBe(MIN_SAMPLES + 2);
    });

    /*
     * The far clock stepped back 60 ms during turnaround, giving a plausible 80 ms round trip
     * that would beat every honest sample.
     */
    it('drops a sample whose far end replied before it received', () => {
      const backward = { t0: 1_100_000, t1: 1_101_000, t2: 1_100_940, t3: 1_100_020 };
      const good = series(MIN_SAMPLES, () => ({ offsetMs: 1000, rttMs: 500 }));

      const estimate = estimateOffset([...good, backward]);
      expect(estimate.samples).toBe(MIN_SAMPLES);
    });

    // Both legs backwards cancel into a positive round trip that a combined check would pass.
    it('drops a sample whose two legs run backwards and cancel', () => {
      const cancelling = { t0: 1_100_100, t1: 0, t2: -20, t3: 1_100_090 };
      const good = series(MIN_SAMPLES, () => ({ offsetMs: 0, rttMs: 60 }));

      const estimate = estimateOffset([...good, cancelling]);
      expect(estimate.samples).toBe(MIN_SAMPLES);
    });
  });
});

/* ==================================================================== the oracle ============ */

/*
 * A synthetic world with a known answer, to check what the estimator CLAIMS against what is
 * TRUE. Every trial draws a true offset, a drift, a path (including one-sided queueing and
 * extreme asymmetry), a responder turnaround, and floors both machines' clocks independently
 * the way Date.now does. The estimator sees only t0..t3 and a monotonic reading.
 *
 * The property is containment: the true offset lies inside the reported range in EVERY trial.
 * It is a guarantee, so 100% is the pass mark and one miss is a failure, not noise. Seeded, so
 * a failure reproduces.
 */

// mulberry32: small, fast, good enough for a test generator.
const seeded = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const between = (random, low, high) => low + random() * (high - low);
const pick = (random, list) => list[Math.floor(random() * list.length)];

/*
 * One run of the exchange. `world` is the true theta at time zero and the drift (far clock
 * rate minus ours); `scenario` shapes the path. Returns the samples, the true offset at any
 * moment, and the true minimum round trip.
 */
const simulate = (random, { atStep = null } = {}) => {
  const theta0 = pick(random, [0, 5_000, -5_000, between(random, -1_000, 1_000), between(random, -60_000, 60_000)]);
  const rate = between(random, -200e-6, 200e-6);
  const epoch = 1_760_000_000_000 + random();
  const farFraction = random();
  const rtt = pick(random, [
    between(random, 1, 5),
    between(random, 5, 30),
    between(random, 30, 120),
    between(random, 120, 300),
    500,
  ]);
  const share = pick(random, [0, 1, 0.5, random(), random()]);
  const turnaroundMax = pick(random, [0, 3, 3, 3, 10_000]);
  const count = 3 + Math.floor(random() * 28);
  const cadence = pick(random, [250, 1_000, 1_000]);
  const jitter = pick(random, [0, 0.5, 2, 10]);
  const outlierRate = pick(random, [0, 0.1, 0.4]);

  // The true offset (far minus local) at monotonic time s.
  // The far clock's sub-millisecond phase is part of the truth, not of the rounding.
  const theta = (s) => theta0 + farFraction + rate * s + (atStep && s >= atStep.at ? atStep.by : 0);
  const local = (s) => Math.floor(epoch + s);
  const far = (s) => Math.floor(epoch + s + theta(s));

  const samples = [];
  let minRtt = Infinity;
  for (let i = 0; i < count; i += 1) {
    const s0 = i * cadence + random() * 5;
    // One-sided queueing: a delay added to a single direction, never negative.
    const queue = () => (random() < outlierRate ? random() * 300 : 0);
    const forward = rtt * share + between(random, 0, jitter) + queue();
    const reverse = rtt * (1 - share) + between(random, 0, jitter) + queue();
    const turnaround = random() < 0.1 ? random() * turnaroundMax : random() * Math.min(turnaroundMax, 3);
    const arrive = s0 + forward;
    const reply = arrive + turnaround;
    const back = reply + reverse;
    samples.push({
      t0: local(s0), t1: far(arrive), t2: far(reply), t3: local(back), m3: back,
    });
    minRtt = Math.min(minRtt, forward + reverse);
  }
  samples.sort((x, y) => x.m3 - y.m3);
  return { samples, theta, minRtt };
};

// The most the tightness claim allows, worked out here from the raw samples and the model.
const tightestAllowed = (samples, ageMs) => {
  const newest = samples[samples.length - 1].m3;
  let best = Infinity;
  for (const sample of samples) {
    if (newest - sample.m3 > WINDOW_MS) continue;
    const roundTripMs = Math.max(0, (sample.t3 - sample.t0) - (sample.t2 - sample.t1));
    const age = newest - sample.m3;
    const slack = DRIFT_RATE * (age + (sample.t3 - sample.t0));
    best = Math.min(best, roundTripMs / 2 + R + slack);
  }
  return best + DRIFT_RATE * ageMs;
};

describe('the estimator against a known truth', () => {
  const TRIALS = 6_000;

  it('contains the true offset in every trial, and is never wider than the fastest sample allows', () => {
    const random = seeded(20_261_002);
    const misses = [];
    let widest = 0;
    let worstLooseness = -Infinity;

    for (let trial = 0; trial < TRIALS; trial += 1) {
      const { samples, theta } = simulate(random);
      // Evaluated some time after the last reply, because a silent channel widens the bound.
      const evaluatedAfter = pick(random, [0, 0, between(random, 0, 5_000)]);
      const newest = samples[samples.length - 1].m3;
      const monoNow = newest + evaluatedAfter;

      const estimate = estimateClock(samples, { monoNow });
      if (estimate.offsetMs === null) {
        misses.push({ trial, why: 'no answer', usable: estimate.usable });
        continue;
      }

      const truth = theta(monoNow);
      const error = Math.abs(estimate.offsetMs - truth);
      if (error > estimate.uncertaintyMs) {
        misses.push({ trial, error, bound: estimate.uncertaintyMs });
      }
      if (estimate.stepAgeMs !== null) misses.push({ trial, why: 'false step' });

      widest = Math.max(widest, estimate.uncertaintyMs);
      worstLooseness = Math.max(
        worstLooseness,
        estimate.uncertaintyMs - tightestAllowed(samples, evaluatedAfter),
      );
    }

    expect(misses.slice(0, 5), `${misses.length} of ${TRIALS} trials missed`).toEqual([]);
    // Tightness: half the fastest round trip, the padding, and the drift terms, nothing more.
    expect(worstLooseness).toBeLessThan(1e-6);
    // The trials include 500 ms paths, so wide ranges were exercised and were answered.
    expect(widest).toBeGreaterThan(200);
  });

  // The guarantee is under any asymmetry, but the estimate is only as good as the split is
  // even: the error is half the asymmetry, which the bound has to cover.
  it('has an error of half the constant asymmetry, always inside the bound', () => {
    const random = seeded(7);
    for (let trial = 0; trial < 500; trial += 1) {
      const forward = between(random, 0, 150);
      const reverse = between(random, 0, 150);
      const theta = between(random, -10_000, 10_000);
      const samples = repeat(10, (i) => {
        const t0 = 2_000_000 + i * 1_000;
        const t1 = t0 + forward + theta;
        return { t0, t1, t2: t1, t3: t0 + forward + reverse, m3: i * 1_000 };
      });

      const estimate = estimateClock(samples);
      expect(estimate.offsetMs - theta).toBeCloseTo((forward - reverse) / 2, 6);
      expect(Math.abs(estimate.offsetMs - theta)).toBeLessThanOrEqual(estimate.uncertaintyMs);
    }
  });

  it('flags a step in the far clock, and recovers on the new offset', () => {
    const random = seeded(99);
    let flagged = 0;
    for (let trial = 0; trial < 300; trial += 1) {
      // 12 s on the old clock, then a step well beyond the round trip, then 6 more samples.
      const by = pick(random, [-3_000, -800, 800, 2_000, 15_000]);
      const world = simulate(random, { atStep: { at: 12_000, by } });
      const after = world.samples.filter((s) => s.m3 > 12_000 + 600);
      if (after.length < MIN_SAMPLES + 1 || world.samples.length - after.length < 3) continue;

      const estimate = estimateClock(world.samples);
      if (estimate.offsetMs === null) continue;
      flagged += estimate.stepAgeMs !== null ? 1 : 0;

      // Whether or not this step was big enough to flag, the estimate must hold its claim for
      // the samples it used: containment at the newest sample's moment.
      const newest = world.samples[world.samples.length - 1].m3;
      if (estimate.stepAgeMs !== null) {
        expect(Math.abs(estimate.offsetMs - world.theta(newest))).toBeLessThanOrEqual(estimate.uncertaintyMs);
      }
    }
    expect(flagged).toBeGreaterThan(30);
  });
});
