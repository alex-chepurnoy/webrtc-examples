import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import DataChannelPanel from '../shared/DataChannelPanel';

/*
 * Chat for the combined page, as one collapsible section below the two panes. Each side shows
 * its own panel only when chat is enabled on that side, and the whole section is absent when
 * neither side has it on.
 *
 * Collapsing hides the panels and does not unmount them, so a half-typed message survives.
 * The log itself and the channel live in the store, not in the panel, so they are unaffected
 * either way.
 */
const LoopbackChat = () => {
  const publishChat = useSelector((state) => Boolean(state.publishSettings.chatEnabled));
  const playChat = useSelector((state) => Boolean(state.playSettings.chatEnabled));
  const count = useSelector((state) =>
    (publishChat ? state.dataChannel.publish.messages.length : 0)
    + (playChat ? state.dataChannel.play.messages.length : 0));

  const [open, setOpen] = useState(false);
  const regionRef = useRef(null);

  // A hidden log has no height, so its scroll position is lost while collapsed: put each
  // log back on its newest message when the section opens.
  useEffect(() => {
    if (!open || !regionRef.current) return;
    regionRef.current.querySelectorAll('.card-body').forEach((log) => {
      log.scrollTop = log.scrollHeight;
    });
  }, [open]);

  if (!publishChat && !playChat) return null;

  return (
    <section className="wz-chat" id="loopback-chat">
      <button
        type="button"
        className="wz-chat__toggle"
        id="loopback-chat-toggle"
        aria-expanded={open}
        aria-controls="loopback-chat-region"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="wz-chat__chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
        Chat
        <span className="wz-chat__count">{count} {count === 1 ? 'message' : 'messages'}</span>
      </button>

      <div className="wz-chat__panels" id="loopback-chat-region" ref={regionRef} hidden={!open}>
        {publishChat ? (
          <div className="wz-chat__side" role="group" aria-labelledby="loopback-chat-publish-label">
            <h3 className="wz-chat__label" id="loopback-chat-publish-label">Publisher chat</h3>
            <DataChannelPanel context="publish" />
          </div>
        ) : null}
        {playChat ? (
          <div className="wz-chat__side" role="group" aria-labelledby="loopback-chat-play-label">
            <h3 className="wz-chat__label" id="loopback-chat-play-label">Player chat</h3>
            <DataChannelPanel context="play" />
          </div>
        ) : null}
      </div>
    </section>
  );
};

export default LoopbackChat;
