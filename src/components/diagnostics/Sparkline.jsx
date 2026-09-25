import React, { useMemo, useState } from 'react';

/*
 * Single-series trend line for a stat tile: no legend or axes, and only the current point
 * carries the accent color.
 *
 * x is time: with `times` the width is the last `windowMs` ending at the newest sample, so the
 * line covers the minute its label names. A sample with no figure is a gap in the line, not
 * a point dropped, which would close the gap up and stretch the rest across the width.
 */

const WIDTH = 62;
const HEIGHT = 18;
const PAD = 2;

const isFigure = (value) => typeof value === 'number' && Number.isFinite(value);

const Sparkline = ({ points, times, format, ariaLabel, windowMs = 60_000 }) => {
  const [hover, setHover] = useState(null);

  const geometry = useMemo(() => {
    const values = Array.isArray(points) ? points : [];
    const timed = Array.isArray(times) && times.length === values.length && times.every(isFigure);
    const newest = timed ? times[times.length - 1] : 0;
    // Only samples inside the window are drawn.
    const shown = (v, i) => isFigure(v) && (!timed || newest - times[i] <= windowMs);

    const figures = values.filter(shown);
    if (figures.length < 2) return null;

    const min = Math.min(...figures);
    const max = Math.max(...figures);
    const innerW = WIDTH - PAD * 2;
    const innerH = HEIGHT - PAD * 2;

    const xAt = (i) => (timed
      ? PAD + Math.max(0, 1 - (newest - times[i]) / windowMs) * innerW
      : PAD + (i / (values.length - 1)) * innerW);
    // A flat series has no span to divide by, so it is drawn along the middle.
    const yAt = (v) => (max === min ? HEIGHT / 2 : HEIGHT - PAD - ((v - min) / (max - min)) * innerH);

    // Each run of figures becomes its own segment of the line.
    const coords = values.map((v, i) => (shown(v, i) ? { x: xAt(i), y: yAt(v), value: v } : null));
    return { coords, min, max };
  }, [points, times, windowMs]);

  if (!geometry) {
    return <div className="wz-spark wz-spark--empty" aria-hidden="true" />;
  }

  const { coords, min, max } = geometry;
  const drawn = coords.filter(Boolean);
  const latest = drawn[drawn.length - 1];

  let path = '';
  coords.forEach((c, i) => {
    if (!c) return;
    const startsRun = i === 0 || !coords[i - 1];
    const endsRun = i === coords.length - 1 || !coords[i + 1];
    const at = `${c.x.toFixed(1)},${c.y.toFixed(1)}`;
    // A lone figure between two gaps is a zero-length segment, which the round cap draws as a dot.
    if (startsRun) path += `${path ? ' ' : ''}M${at}${endsRun ? ` L${at}` : ''}`;
    else path += ` L${at}`;
  });

  const active = hover === null ? null : drawn[hover];
  const show = (value) => (format ? format(value) : String(value));

  // The hover readout, for anyone who cannot hover: newest figure and the range shown.
  const summary = `${ariaLabel}: latest ${show(latest.value)}, lowest ${show(min)}, highest ${show(max)}`;

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * WIDTH;
    let nearest = 0;
    drawn.forEach((c, i) => {
      if (Math.abs(c.x - x) < Math.abs(drawn[nearest].x - x)) nearest = i;
    });
    setHover(nearest);
  };

  return (
    <div className="wz-spark">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <path d={path} className="wz-spark__line" />
        {active ? (
          <>
            <line
              x1={active.x} y1={0} x2={active.x} y2={HEIGHT}
              className="wz-spark__crosshair"
            />
            <circle cx={active.x} cy={active.y} r="2.5" className="wz-spark__hover" />
          </>
        ) : null}
        <circle cx={latest.x} cy={latest.y} r="2.5" className="wz-spark__now" />
      </svg>
      {active && format ? (
        <span className="wz-spark__tip" aria-hidden="true">{format(active.value)}</span>
      ) : null}
    </div>
  );
};

export default Sparkline;
