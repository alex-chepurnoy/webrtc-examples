import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import * as PlaySettingsActions from '../../actions/playSettingsActions';
import { attachProbeVideoElement } from '../../diagnostics/latencyProbe';
import * as WebRTCPlayActions from '../../actions/webrtcPlayActions';
import * as ErrorsActions from '../../actions/errorsActions';
import * as DataChannelActions from '../../actions/dataChannelActions';
import { describeReceivedMessage } from '../../utils/DataChannelUtils';
import { CHAT_CHANNEL_LABEL, CAPTIONS_CHANNEL_LABEL, DATA_CHANNELS_UNAVAILABLE_MESSAGE } from '../../webrtc/attachDataChannel';

import startPlay from '../../webrtc/startPlay';
import stopPlay from '../../webrtc/stopPlay';

const Player = () => {

  const videoElement = useRef(null);
  const maxWidthRef = useRef(0);
  const peerConnectionRef = useRef(undefined);
  const websocketRef = useRef(undefined);
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });

  const dispatch = useDispatch();
  const playSettings = useSelector ((state) => state.playSettings);
  const { peerConnection, websocket, connected, stream } = useSelector ((state) => state.webrtcPlay);

  // Listen for changes in the play* flags in the playSettings store
  // and stop or stop playback accordingly

  useEffect(() => {

    const stopCallbacks = {
      onSetPeerConnection: (result) => {
        peerConnectionRef.current = result.peerConnection;
        dispatch({type:WebRTCPlayActions.SET_WEBRTC_PLAY_PEERCONNECTION,peerConnection:result.peerConnection});
      },
      onSetWebsocket: (result) => {
        websocketRef.current = result.websocket;
        dispatch({type:WebRTCPlayActions.SET_WEBRTC_PLAY_WEBSOCKET,websocket:result.websocket});
      },
      onPlayStopped: () => {
        // Clearing the stream detaches it from whichever player is mounted (see below).
        dispatch({type:WebRTCPlayActions.SET_WEBRTC_PLAY_STREAM,stream:undefined});
        dispatch({type:WebRTCPlayActions.SET_WEBRTC_PLAY_CONNECTED,connected:false});
        dispatch(DataChannelActions.resetDataChannel('play'));
      }
    };

    if (playSettings.playStart && !playSettings.playStarting && !connected)
    {
      dispatch({type:PlaySettingsActions.SET_PLAY_FLAGS, playStart:false, playStarting:true});
      // One stream per session, published to the store on its first track.
      const sessionStream = new MediaStream();
      startPlay(playSettings, {
        onError: (error) => {
          dispatch({type:ErrorsActions.SET_ERROR_MESSAGE,message:error.message});
          stopPlay(playSettings, peerConnectionRef.current, websocketRef.current, stopCallbacks);
          dispatch({ type: PlaySettingsActions.SET_PLAY_FLAGS, playStart: false, playStarting: false, playStop: false, playStopping: false });
        },
        onConnectionStateChange: (result) => {
          dispatch({type:WebRTCPlayActions.SET_WEBRTC_PLAY_CONNECTED,connected:result.connected});
        },
        onSetPeerConnection: stopCallbacks.onSetPeerConnection,
        onSetWebsocket: stopCallbacks.onSetWebsocket,
        onPeerConnectionOnTrack: (event) => {
          console.log('ontrack:', event.track.kind, 'muted:', event.track.muted, 'readyState:', event.track.readyState);
          const first = sessionStream.getTracks().length === 0;
          sessionStream.addTrack(event.track);
          // Published once. The element is attached when the stream identity changes, and
          // reassigning on every track reloads the element after the Play click's gesture has
          // expired, which leaves Safari with audio and no picture.
          if (first) dispatch({type:WebRTCPlayActions.SET_WEBRTC_PLAY_STREAM,stream:sessionStream});
        },
        onSetDataChannel: (result) => {
          // Only the chat channel is sent on from the UI; the captions handle is receive-only.
          if (result.label === CHAT_CHANNEL_LABEL)
            dispatch(DataChannelActions.setDataChannelHandle('play', result.dataChannel));
        },
        onDataChannelStateChange: (result) => {
          // The panel tracks the chat channel's lifecycle; captions state isn't shown.
          if (result.label === CHAT_CHANNEL_LABEL)
            dispatch(DataChannelActions.setDataChannelState('play', result));
        },
        onDataChannelMessage: (result) => {
          if (result.label === CAPTIONS_CHANNEL_LABEL)
            dispatch(DataChannelActions.setCaption('play', result.data));
          else
            dispatch(DataChannelActions.addDataChannelMessage('play', describeReceivedMessage(result)));
        },
        onDataChannelError: (result) => {
          dispatch({type:ErrorsActions.SET_ERROR_MESSAGE, message:'Data channel error: ' + result.message});
        },
        onDataChannelsUnavailable: () => {
          // Playback is unaffected, so this only reports - no media state is touched.
          dispatch({type:ErrorsActions.SET_ERROR_MESSAGE, message:DATA_CHANNELS_UNAVAILABLE_MESSAGE});
        }
      });
    }
    if (playSettings.playStarting && connected)
    {
      dispatch({type:PlaySettingsActions.SET_PLAY_FLAGS, playStarting:false});
    }

    // A session that never reached "connected" still has to be stoppable - otherwise a start that
    // stalls mid-negotiation leaves the page with no way out.
    if (playSettings.playStop && !playSettings.playStopping && (connected || peerConnection))
    {
      dispatch({type:PlaySettingsActions.SET_PLAY_FLAGS, playStop:false, playStopping:true});
      stopPlay(playSettings, peerConnection, websocket, stopCallbacks);
    }
    if (playSettings.playStopping && !connected)
    {
      dispatch({type:PlaySettingsActions.SET_PLAY_FLAGS, playStopping:false});
    }


  }, [dispatch,videoElement,playSettings,peerConnection,websocket,connected]);

  // Dimensions come from loadedmetadata and loadeddata as well as resize, since resize alone
  // can arrive late for the first frame.
  useEffect(() => {
    const video = videoElement.current;
    if (!video) return;

    const updateSize = () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (width > maxWidthRef.current) maxWidthRef.current = width;
      setVideoSize({ width, height });
    };

    video.addEventListener('loadedmetadata', updateSize);
    video.addEventListener('loadeddata', updateSize);
    video.addEventListener('resize', updateSize);
    updateSize();
    return () => {
      video.removeEventListener('loadedmetadata', updateSize);
      video.removeEventListener('loadeddata', updateSize);
      video.removeEventListener('resize', updateSize);
    };
  }, [connected]);

  // Reset the "max width seen" baseline between sessions so a new connection
  // doesn't inherit the previous publisher's reference resolution.
  useEffect(() => {
    if (!connected) {
      maxWidthRef.current = 0;
      setVideoSize({ width: 0, height: 0 });
    }
  }, [connected]);

  /*
   * Sound starts on: the Play click unmutes the element while it is still a user gesture. If
   * the browser refuses sound anyway (NotAllowedError), playback would stop with no picture,
   * so the first metadata retries silent and offers "Click to unmute". The toggle below keeps
   * sound controllable whenever media is flowing, picture or not.
   *
   * The gesture and playing flags name the stream they were raised for, so they end with the
   * session that raised them: a stop or a new session clears them without an effect to reset
   * them, and "Click to unmute" cannot come back when sound is later muted from the controls.
   */
  const [muted, setMuted] = useState(false);
  const [needsGestureFor, setNeedsGestureFor] = useState(null);
  const [playingFor, setPlayingFor] = useState(null);

  useEffect(() => {
    const video = videoElement.current;
    if (!video) return undefined;
    const sync = () => setMuted(video.muted);
    const onPlaying = () => setPlayingFor(video.srcObject);
    const ensurePlaying = async () => {
      if (!video.paused) return;
      try {
        await video.play();
      } catch (error) {
        // Only a refusal of sound is helped by muting. An AbortError is a load interrupted by a
        // new source or a stop mid-start, and is not a reason to take the sound away.
        if (error?.name !== 'NotAllowedError') return;
        video.muted = true;
        sync();
        try { await video.play(); } catch { /* nothing more to try without a gesture */ }
        setNeedsGestureFor(video.srcObject);
      }
    };
    video.addEventListener('volumechange', sync);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('loadedmetadata', ensurePlaying);
    return () => {
      video.removeEventListener('volumechange', sync);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('loadedmetadata', ensurePlaying);
    };
  }, []);

  /*
   * The session's stream goes onto whichever element is mounted, so leaving Play and coming
   * back finds the session still showing instead of "Not playing" beside a Stop button. Only
   * on a change of stream: reassigning the same one reloads the element (see the ontrack
   * note above).
   */
  useEffect(() => {
    const video = videoElement.current;
    if (!video) return undefined;
    if (video.srcObject !== (stream ?? null)) video.srcObject = stream ?? null;
    return () => { video.srcObject = null; };
  }, [stream]);

  const setSound = useCallback((on) => {
    const video = videoElement.current;
    if (!video) return;
    video.muted = !on;
    setMuted(!on);
    if (on) video.play().catch(() => {});
    setNeedsGestureFor(null);
  }, []);

  const live = connected && stream != null;
  const needsGesture = live && needsGestureFor === stream;
  // No picture until both dimensions are known. The video is never display:none (WebKit may
  // not paint a video that started playing hidden); the placeholder covers it until then.
  const hasPicture = connected && videoSize.width > 0 && videoSize.height > 0;
  // Media flowing with no picture: an audio-only stream. The element and its controls are
  // left uncovered, since there is nothing for a placeholder to stand in for.
  const flowing = live && (hasPicture || playingFor === stream);

  /*
   * The probe's decode-and-display leg is measured from this element, because
   * requestVideoFrameCallback is the only thing that reports when a frame was actually put on
   * screen. The encoded side of the probe attaches to the receiver in startPlay; this is the
   * other half of the join, and without it the panel has a transport figure and dashes for the
   * player leg and the total.
   */
  useEffect(() => {
    if (!hasPicture || !playSettings.latencyProbe) return undefined;
    const element = videoElement.current;
    if (!element) return undefined;
    const joined = attachProbeVideoElement(element);
    return () => joined.stop();
  }, [hasPicture, playSettings.latencyProbe]);

  return (
  <>
    {!flowing && (
      <div className="wz-video-placeholder wz-video-placeholder--over">
        {connected ? 'Waiting for media' : 'Not playing'}
      </div>
    )}
    <video
      id="player-video"
      ref={videoElement}
      autoPlay
      playsInline
      controls
      style={hasPicture ? { '--wz-video-ar': videoSize.width / videoSize.height } : undefined}
    />
    {/* Not gated on media flowing: a refusal can leave the element paused, and this button
        is then the only way to start it. */}
    {needsGesture && muted && (
      <button
        type="button"
        id="player-unmute"
        className="wz-unmute"
        onClick={() => setSound(true)}
      >
        Click to unmute
      </button>
    )}
    {/* The label is the action, so it carries no pressed state as well. */}
    {flowing && (
      <button
        type="button"
        id="player-mute-toggle"
        className="wz-mute-toggle"
        onClick={() => setSound(muted)}
      >
        {muted ? 'Unmute' : 'Mute'}
      </button>
    )}
    {flowing && (
      <div id="rendition-badge">
        {hasPicture ? <>{videoSize.width}&times;{videoSize.height}</> : 'Audio only'}
      </div>
    )}
  </>
);
}

export default Player;