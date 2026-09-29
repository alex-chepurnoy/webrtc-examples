import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import InfoTip, { LabelWithInfo } from './InfoTip';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Focus opens a tip only when it came from the keyboard, so tests say which it was.
const keyboardFocus = (element) => {
  fireEvent.keyDown(document, { key: 'Tab' });
  act(() => element.focus());
};

const pointerFocus = (element) => {
  fireEvent.pointerDown(element, { pointerType: 'mouse' });
  act(() => element.focus());
};

const renderTip = () => {
  render(<InfoTip topic="Scale down">Divides the width and the height.</InfoTip>);
  const button = screen.getByRole('button', { name: 'About Scale down' });
  const tip = document.getElementById(button.getAttribute('aria-controls'));
  return { button, tip };
};

describe('InfoTip', () => {
  it('names the setting and points at its text', () => {
    const { button, tip } = renderTip();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(tip).toHaveAttribute('role', 'tooltip');
    expect(button).toHaveAttribute('aria-describedby', tip.id);
    expect(tip).toHaveTextContent('Divides the width and the height.');
    expect(tip).not.toBeVisible();
    // Not a title tooltip: those reach neither a keyboard nor a touch screen.
    expect(button).not.toHaveAttribute('title');
  });

  it('renders the text outside its parent, so a scrolling panel cannot clip it', () => {
    const { container } = render(
      <div style={{ overflow: 'auto' }}><InfoTip topic="x">text</InfoTip></div>
    );
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(container.contains(tip)).toBe(false);
    expect(tip.parentElement).toBe(document.body);
  });

  it('opens on mouse over and closes shortly after the pointer leaves', () => {
    vi.useFakeTimers();
    const { button, tip } = renderTip();
    fireEvent.pointerOver(button, { pointerType: 'mouse' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(tip).toBeVisible();

    fireEvent.pointerOut(button, { pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(200); });
    expect(tip).not.toBeVisible();
  });

  it('stays open while the pointer moves from the button onto the text', () => {
    vi.useFakeTimers();
    const { button, tip } = renderTip();
    fireEvent.pointerOver(button, { pointerType: 'mouse' });
    fireEvent.pointerOut(button, { pointerType: 'mouse', relatedTarget: tip });
    fireEvent.pointerOver(tip, { pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(200); });
    expect(tip).toBeVisible();
  });

  it('opens on keyboard focus and closes on blur', () => {
    const { button, tip } = renderTip();
    keyboardFocus(button);
    expect(tip).toBeVisible();
    act(() => button.blur());
    expect(tip).not.toBeVisible();
  });

  it('closes on Escape and keeps focus on the button', () => {
    const { button, tip } = renderTip();
    keyboardFocus(button);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(tip).not.toBeVisible();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(button);
  });

  it('does not open from the focus a mouse click gives', () => {
    const { button, tip } = renderTip();
    pointerFocus(button);
    expect(tip).not.toBeVisible();
  });

  // The review case: pin, close, then hover and leave. The button still has focus from the
  // clicks, and that focus must not hold the tip open.
  it('closes after a pin, a closing click and a hover out, although the button keeps focus', () => {
    vi.useFakeTimers();
    const { button, tip } = renderTip();
    fireEvent.pointerOver(button, { pointerType: 'mouse' });
    pointerFocus(button);
    fireEvent.click(button);
    expect(tip).toBeVisible();
    fireEvent.pointerDown(button, { pointerType: 'mouse' });
    fireEvent.click(button);
    expect(tip).not.toBeVisible();

    fireEvent.pointerOut(button, { pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.pointerOver(button, { pointerType: 'mouse' });
    expect(tip).toBeVisible();
    fireEvent.pointerOut(button, { pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(200); });
    expect(document.activeElement).toBe(button);
    expect(tip).not.toBeVisible();
  });

  it('closes a pinned tip when its button is hidden with its tab', () => {
    const Tab = ({ hidden }) => (
      <div hidden={hidden}><InfoTip topic="x">text</InfoTip></div>
    );
    const { rerender } = render(<Tab hidden={false} />);
    const button = screen.getByRole('button', { name: 'About x' });
    fireEvent.click(button);
    expect(screen.getByRole('tooltip')).toBeVisible();
    rerender(<Tab hidden />);
    // What a ResizeObserver or a scroll reports when the button collapses.
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(screen.getByRole('tooltip', { hidden: true })).not.toBeVisible();
  });

  it('opens on a tap, which has no hover, and closes on a second tap', () => {
    const { button, tip } = renderTip();
    fireEvent.click(button);
    expect(tip).toBeVisible();
    fireEvent.click(button);
    expect(tip).not.toBeVisible();
  });

  it('closes a pinned tip when something else is tapped', () => {
    render(<><InfoTip topic="x">text</InfoTip><button type="button">elsewhere</button></>);
    const button = screen.getByRole('button', { name: 'About x' });
    fireEvent.click(button);
    expect(screen.getByRole('tooltip')).toBeVisible();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.getByRole('tooltip', { hidden: true })).not.toBeVisible();
  });

  it('is never disabled, so it works while the field it explains is locked', () => {
    render(<><input disabled aria-label="locked" /><InfoTip topic="locked">why</InfoTip></>);
    expect(screen.getByRole('button', { name: 'About locked' })).toBeEnabled();
  });
});

describe('LabelWithInfo', () => {
  it('keeps the field named by its label alone', () => {
    render(
      <>
        <LabelWithInfo htmlFor="f" label="Max video bitrate">text</LabelWithInfo>
        <input id="f" />
      </>
    );
    expect(screen.getByRole('textbox', { name: 'Max video bitrate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About Max video bitrate' })).toBeInTheDocument();
  });
});
