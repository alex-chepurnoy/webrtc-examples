import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import MaxBitrateField from './MaxBitrateField';

afterEach(cleanup);

const renderField = (props = {}) => {
  const onCommit = vi.fn();
  render(
    <MaxBitrateField id="videoMaxBitrate" label="Max video bitrate" value="" onCommit={onCommit} {...props}>
      help text
    </MaxBitrateField>
  );
  return { onCommit, field: screen.getByRole('textbox', { name: 'Max video bitrate' }) };
};

describe('MaxBitrateField', () => {
  it('commits on blur, once, not per keystroke', () => {
    const { onCommit, field } = renderField();
    fireEvent.change(field, { target: { value: '3' } });
    fireEvent.change(field, { target: { value: '30' } });
    fireEvent.change(field, { target: { value: '300' } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(field);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('300');
  });

  it('commits on Enter, trimmed', () => {
    const { onCommit, field } = renderField();
    fireEvent.change(field, { target: { value: ' 800 ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('800');
  });

  it('does not commit an unchanged value', () => {
    const { onCommit, field } = renderField({ value: '300' });
    fireEvent.change(field, { target: { value: '300' } });
    fireEvent.blur(field);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits a cleared field as blank, which means no limit', () => {
    const { onCommit, field } = renderField({ value: '300' });
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(onCommit).toHaveBeenCalledWith('');
    expect(field).toHaveAttribute('placeholder', 'No limit');
  });

  it('shows an error and ties it to the field', () => {
    const { field } = renderField({ value: '10', error: 'Max video bitrate must be from 50 to 20000 kbps, or blank for no limit' });
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(/from 50 to 20000 kbps/);
    expect(screen.getByRole('alert')).toBeVisible();
  });

  it('says why it is disabled, and keeps its explainer usable', () => {
    const { field } = renderField({ disabled: true, note: 'Set per rendition under Simulcast.' });
    expect(field).toBeDisabled();
    expect(field).toHaveAccessibleDescription('Set per rendition under Simulcast.');
    expect(screen.getByRole('button', { name: 'About Max video bitrate' })).toBeEnabled();
  });
});
