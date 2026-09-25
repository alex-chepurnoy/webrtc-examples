import React, { useState, useCallback, useEffect, useRef } from 'react';

import ExternalLinks from '../../constants/ExternalLinks';
import Resizer from './Resizer';
import { useResizable } from '../../hooks/useResizable';

/*
 * The right-hand settings panel. `tabs` is [{ id, label, render }]; optional `sides` adds a
 * switch above the tabs (combined page); `actions` is the sticky footer for the primary
 * control. Resizable from its left edge, capped so the stage always keeps room.
 */
const Inspector = ({ tabs, actions, legacyHref = null, sides = null, side = null, onSideChange = null }) => {
  const [active, setActive] = useState(tabs[0].id);

  // The combined page swaps tab arrays, so the selected tab can vanish: fall back to the first.
  useEffect(() => {
    if (!tabs.some((t) => t.id === active)) setActive(tabs[0].id);
  }, [tabs, active]);

  const current = tabs.find((t) => t.id === active) || tabs[0];

  /*
   * The WAI-ARIA tabs pattern: the strip is one Tab stop (the selected tab), and the arrow
   * keys, Home and End move the selection along it. Selection follows focus, because every
   * panel is a form that renders at once.
   */
  const tabRefs = useRef({});
  const onTabKeyDown = (event) => {
    const index = tabs.findIndex((t) => t.id === current.id);
    let next = null;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next === null) return;

    event.preventDefault();
    const id = tabs[next].id;
    setActive(id);
    tabRefs.current[id]?.focus();
  };

  const maxWidth = useCallback(() => Math.max(300, window.innerWidth - 520), []);
  const { size, handleProps, targetRef } = useResizable({
    axis: 'x',
    initial: 340,
    min: 280,
    max: maxWidth,
    invert: true,
    storageKey: 'wz.inspector.width',
  });

  return (
    <>
    <Resizer label="Resize the settings panel" {...handleProps} />
    <aside ref={targetRef} className="wz-inspector" aria-label="Settings" style={{ width: size }}>
      {sides ? (
        <div className="wz-inspector__switch">
          <div className="wz-segment" role="group" aria-label="Which connection these settings apply to">
            {sides.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={side === s.id}
                onClick={() => onSideChange && onSideChange(s.id)}
                data-label={s.label}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="wz-tabs" role="tablist" aria-label="Settings sections" onKeyDown={onTabKeyDown}>
        {tabs.map((t) => (
          <button
            key={t.id}
            ref={(el) => { tabRefs.current[t.id] = el; }}
            type="button"
            role="tab"
            id={'tab-' + t.id}
            aria-selected={current.id === t.id}
            /* Only the selected tab's panel is rendered, so only it has a panel to point at. */
            aria-controls={current.id === t.id ? 'panel-' + t.id : undefined}
            tabIndex={current.id === t.id ? 0 : -1}
            onClick={() => setActive(t.id)}
            /* The label again, for the width reservation in shell.css. */
            data-label={t.label}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div
        className="wz-inspector__body"
        role="tabpanel"
        id={'panel-' + current.id}
        aria-labelledby={'tab-' + current.id}
      >
        {current.render()}
      </div>

      {actions ? <div className="wz-inspector__actions">{actions}</div> : null}

      {/* Outside the scrolling body: the sticky primary action would cover it there. */}
      {legacyHref ? (
        <div className="wz-inspector__foot">
          <small>
            {ExternalLinks.legacyLinkText}{' '}
            <a href={legacyHref} target="_blank" rel="noopener noreferrer">
              {ExternalLinks.legacyLinkLabel}
            </a>
          </small>
        </div>
      ) : null}
    </aside>
    </>
  );
};

export default Inspector;