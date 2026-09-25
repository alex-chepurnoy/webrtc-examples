import React, { useEffect } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { useLocation } from 'react-router-dom';
import { HIDE_ERROR_PANEL } from '../../actions/errorsActions';

// The page the banner was last on. Module scope, because each page mounts its own banner.
let lastPathname = null;

/*
 * Error banner. Rendered in the page header rather than inline in the content, so a
 * failure is visible wherever the user has scrolled to and does not shift the layout
 * of the page underneath it.
 *
 * Cleared on a change of page, since the message is about the page that was left, and by
 * the forms when a new publish or play starts.
 */
const Errors = () => {
  const dispatch = useDispatch();
  const errors = useSelector((state) => state.errors);
  const { pathname } = useLocation();

  useEffect(() => {
    if (lastPathname !== null && lastPathname !== pathname) dispatch({ type: HIDE_ERROR_PANEL });
    lastPathname = pathname;
  }, [dispatch, pathname]);

  if (errors.show === false) return null;

  return (
    <div className="wz-error" role="alert" id="error-panel">
      <span className="wz-error__icon" aria-hidden="true">!</span>
      <div className="wz-error__message" id="error-messages">{errors.message}</div>
      <button
        id="error-panel-close"
        type="button"
        className="wz-error__close"
        aria-label="Dismiss error"
        onClick={() => dispatch({ type: HIDE_ERROR_PANEL })}
      >
        &times;
      </button>
    </div>
  );
};

export default Errors;