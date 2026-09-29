import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/*
 * A small "i" button beside a field label that explains the setting in a pop-over.
 *
 * It opens on mouse over, on keyboard focus and on a tap, because hover alone reaches
 * neither a keyboard nor a touch screen. It is not a title attribute for the same reason, and
 * because a title cannot hold a paragraph. A click or tap pins it open; a second one, a tap
 * elsewhere or Escape closes it.
 *
 * The text is rendered into document.body with position: fixed, placed from the button's own
 * rectangle. Inside the inspector it would be clipped by the scrolling panel body, which is
 * exactly where the last fields of a tab sit. It flips above the button when there is no room
 * below and is kept inside the viewport either way.
 *
 * The button is never disabled, even when the field beside it is: why a setting is locked
 * while connected is one of the things someone reads these for.
 */

// Long enough to move the pointer from the button onto the pop-over without it closing.
const CLOSE_DELAY_MS = 120;
const GAP = 6;
const EDGE = 8;

const InfoTip = ({ topic, children, className = '' }) => {
  const id = useId();
  const tipId = `info-tip-${id.replace(/:/g, '')}`;
  const buttonRef = useRef(null);
  const tipRef = useRef(null);
  const closeTimer = useRef(null);

  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  // Set by Escape or a closing click, and cleared when focus leaves or the pointer comes
  // back, so a dismissed tip does not reopen underneath a pointer that never moved.
  const [dismissed, setDismissed] = useState(false);
  const [position, setPosition] = useState(null);

  const open = !dismissed && (hovered || focused || pinned);

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  // Coming back over it is a new request to read it, so it undoes a dismissal. Leaving does
  // not: after a closing click the button keeps focus, and that must not reopen it.
  const hoverOn = () => {
    cancelClose();
    setHovered(true);
    setDismissed(false);
  };

  const hoverOff = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setHovered(false), CLOSE_DELAY_MS);
  };

  useEffect(() => () => cancelClose(), []);

  const close = useCallback(() => {
    setPinned(false);
    setDismissed(true);
  }, []);

  // Escape anywhere closes it, including while only the pointer is over it. Focus goes back
  // to the button, which is where it already is when the tip was opened from the keyboard.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      close();
      if (tipRef.current && tipRef.current.contains(document.activeElement)) buttonRef.current?.focus();
    };
    // A tap or click anywhere else unpins it.
    const onPointerDown = (event) => {
      if (buttonRef.current?.contains(event.target) || tipRef.current?.contains(event.target)) return;
      setPinned(false);
      setHovered(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  // Placed after it renders, so its real height decides whether it goes above or below.
  const place = useCallback(() => {
    const button = buttonRef.current;
    const tip = tipRef.current;
    if (!button || !tip) return;
    const anchor = button.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = window.innerHeight;

    let top = anchor.bottom + GAP;
    if (top + height > viewportHeight - EDGE && anchor.top - GAP - height >= EDGE) {
      top = anchor.top - GAP - height;
    }
    top = Math.max(EDGE, Math.min(top, viewportHeight - EDGE - height));

    // Right-aligned to the button: the info buttons sit at the right of their labels, and
    // the inspector is on the right of the window.
    let left = anchor.right - width;
    left = Math.max(EDGE, Math.min(left, viewportWidth - EDGE - width));

    setPosition({ top: Math.round(top), left: Math.round(left) });
  }, []);

  // A closed tip keeps its last position; it is hidden, and the next open places it again
  // before the browser paints.
  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    // The panel scrolls and resizes under an open tip; follow the button rather than float.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  const onClick = () => {
    if (pinned) {
      close();
      return;
    }
    setDismissed(false);
    setPinned(true);
  };

  const tip = (
    <div
      ref={tipRef}
      id={tipId}
      role="tooltip"
      className="wz-info-tip"
      hidden={!open}
      style={position
        ? { top: position.top, left: position.left }
        : { top: 0, left: 0, visibility: open ? 'hidden' : undefined }}
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') hoverOn(); }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') hoverOff(); }}
    >
      {children}
    </div>
  );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={className ? `wz-info-button ${className}` : 'wz-info-button'}
        aria-label={`About ${topic}`}
        aria-expanded={open}
        aria-controls={tipId}
        aria-describedby={tipId}
        onPointerEnter={(e) => { if (e.pointerType === 'mouse') hoverOn(); }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') hoverOff(); }}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); setDismissed(false); }}
        onClick={onClick}
      >
        <span aria-hidden="true">i</span>
      </button>
      {createPortal(tip, document.body)}
    </>
  );
};

/*
 * A label with its info button. The label keeps htmlFor, so the field's accessible name is
 * still just the label's words; the button is a sibling, not part of it.
 */
export const LabelWithInfo = ({ htmlFor, label, topic, children }) => (
  <div className="wz-label-row">
    <label htmlFor={htmlFor}>{label}</label>
    <InfoTip topic={topic || label}>{children}</InfoTip>
  </div>
);

export default InfoTip;
