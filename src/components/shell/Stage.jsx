import React from 'react';

import Errors from './Errors';
import StatusBadges from './StatusBadges';

/*
 * The center column shell: topbar, video area, stat strip, and docked content. `badges`
 * adds to LIVE and PLAYING at the right end of the topbar. `dock` is the server communication
 * log: everything else scrolls as one column above it, so dragging the log tall never hides a
 * panel, it only makes the column scroll.
 */
const Stage = ({ title, target, badges, dock, children }) => (
  <div className="wz-stage">
    <div className="wz-topbar">
      <span className="wz-topbar__title">{title}</span>
      {target ? <span className="wz-topbar__target">{target}</span> : null}
      <div style={{ flexGrow: 1 }} />
      {badges}
      <StatusBadges />
    </div>
    <Errors />
    <div className="wz-stage__scroll">{children}</div>
    {dock}
  </div>
);

export default Stage;
