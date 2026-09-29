import React, { useState } from 'react';
import { LabelWithInfo } from '../shared/InfoTip';

/*
 * A bitrate cap in kbps: blank is no cap. It applies to the live sender, so an edit is
 * committed on blur or Enter, never per keystroke: every commit is one setParameters, and a
 * half-typed "3" on the way to "300" would briefly cap the stream at 3 kbps.
 *
 * `error` is worked out by the caller from the committed value, which is what the sender
 * gets. `note` explains a disabled field, and stays on screen because it says how to
 * enable it.
 */
const MaxBitrateField = ({ id, label, value, error, disabled, note, onCommit, children }) => {
  const [draft, setDraft] = useState(null);

  const commit = () => {
    if (draft == null) return;
    setDraft(null);
    const next = draft.trim();
    if (next !== String(value ?? '')) onCommit(next);
  };

  const describedBy = [error ? `${id}-error` : null, note ? `${id}-note` : null]
    .filter(Boolean).join(' ') || undefined;

  return (
    <div className="mb-3">
      <LabelWithInfo htmlFor={id} label={label}>{children}</LabelWithInfo>
      <div className="input-group">
        <input
          type="text"
          inputMode="numeric"
          className={error ? 'form-control is-invalid' : 'form-control'}
          id={id}
          name={id}
          placeholder="No limit"
          autoComplete="off"
          value={draft ?? value ?? ''}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            // Enter would otherwise submit the settings form.
            e.preventDefault();
            commit();
          }}
        />
        <span className="input-group-text">kbps</span>
      </div>
      {error && (
        <small className="wz-field-error" id={`${id}-error`} role="alert">{error}</small>
      )}
      {note && (
        <small className="form-text text-muted" id={`${id}-note`}>{note}</small>
      )}
    </div>
  );
};

export default MaxBitrateField;
