import React, { useEffect } from 'react';
import { useDispatch, useSelector, useStore } from 'react-redux';

import * as PublishSettingsActions from '../../actions/publishSettingsActions';
import * as WebRTCPublishActions from '../../actions/webrtcPublishActions';
import * as ErrorsActions from '../../actions/errorsActions';
import * as DataChannelActions from '../../actions/dataChannelActions';
import { describeReceivedMessage } from '../../utils/DataChannelUtils';
import { DATA_CHANNELS_UNAVAILABLE_MESSAGE } from '../../webrtc/attachDataChannel';

import publishSupervisor from '../../webrtc/publishSupervisor';
import replaceAudioTrack from '../../webrtc/replaceAudioTrack';
import replaceVideoTrack from '../../webrtc/replaceVideoTrack';
import {
  applyAudioSenderParameters,
  applyVideoSenderParameters,
  audioSenderSettings,
  videoSenderSettings,
} from '../../utils/SenderParameters';

// What a republish must read from the store rather than from the snapshot taken at Start: the
// tracks, which a camera or microphone switch replaces mid-session (a burned-in clock track
// included), and the sender limits, which can be edited while live.
const liveSettings = (settings) => ({
  audioTrack: settings.audioTrack,
  videoTrack: settings.videoTrack,
  videoMaxBitrateKbps: settings.videoMaxBitrateKbps,
  audioMaxBitrateKbps: settings.audioMaxBitrateKbps,
  degradationPreference: settings.degradationPreference,
  simulcastRenditions: settings.simulcastRenditions,
});

const Publisher = () => {

  const dispatch = useDispatch();
  const store = useStore();
  const publishSettings = useSelector ((state) => state.publishSettings);
  const webrtcPublish = useSelector ((state) => state.webrtcPublish);

  // Listen for changes in the publish* flags in the publishSettings store
  // and stop or stop publishing accordingly

  useEffect(() => {

    // The session belongs to the supervisor, not to this component: it outlives a page change
    // and a StrictMode remount, and start() is a no-op while one is running.
    const clearSession = () => {
      dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_CONNECTED, connected:false});
      dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_WEBSOCKET, websocket:null});
      dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_PEERCONNECTION, peerConnection:null});
      dispatch(DataChannelActions.resetDataChannel('publish'));
    };

    if (publishSettings.publishStart && !publishSettings.publishStarting && !webrtcPublish.connected
        && !publishSupervisor.active)
    {
      dispatch({type:PublishSettingsActions.SET_PUBLISH_FLAGS, publishStart:false, publishStarting:true});
      publishSupervisor.start({
        settings: publishSettings,
        readLive: () => liveSettings(store.getState().publishSettings),
        ui: {
          onReconnecting: (reconnecting) => {
            dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_RECONNECTING, reconnecting});
          },
          // Between attempts nothing is connected, and the old handles must not be used.
          onAttemptEnded: clearSession,
          // The first attempt failing, or recovery giving up. Either way the session is over.
          onFailed: (message) => {
            dispatch({type:ErrorsActions.SET_ERROR_MESSAGE, message});
            dispatch({type:PublishSettingsActions.SET_PUBLISH_FLAGS, publishStarting:false, publishStart:false});
            clearSession();
          },
        },
        // Fresh for every attempt, so each new connection reports into the store the same way.
        makeCallbacks: () => ({
          // A warning is shown but changes nothing else: the session stays up. Used when the
          // server refuses the video track while audio keeps flowing.
          onWarning: (warning) => {
            dispatch({type:ErrorsActions.SET_ERROR_MESSAGE, message:warning.message});
          },
          onConnectionStateChange: (result) => {
            dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_CONNECTED,connected:result.connected});
          },
          onSetPeerConnection: (result) => {
            dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_PEERCONNECTION,peerConnection:result.peerConnection});
          },
          onSetWebsocket: (result) => {
            dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_WEBSOCKET,websocket:result.websocket});
          },
          // New senders on every attempt. The limit effects below depend on the sender objects,
          // so a republished session gets the caps again through the same serialized queue.
          onSetSenders: (senders) => {
            dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_PEERCONNECTION_AUDIO_SENDER,peerConnectionAudioSender:senders.audioSender});
            dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_PEERCONNECTION_VIDEO_SENDER,peerConnectionVideoSender:senders.videoSender});
          },
          onSetDataChannel: (result) => {
            dispatch(DataChannelActions.setDataChannelHandle('publish', result.dataChannel));
          },
          onDataChannelStateChange: (result) => {
            dispatch(DataChannelActions.setDataChannelState('publish', result));
          },
          onDataChannelMessage: (result) => {
            dispatch(DataChannelActions.addDataChannelMessage('publish', describeReceivedMessage(result)));
          },
          onDataChannelError: (result) => {
            dispatch({type:ErrorsActions.SET_ERROR_MESSAGE, message:'Data channel error: ' + result.message});
          },
          onDataChannelsUnavailable: () => {
            // Publishing is unaffected, so this only reports - no media state is touched.
            dispatch({type:ErrorsActions.SET_ERROR_MESSAGE, message:DATA_CHANNELS_UNAVAILABLE_MESSAGE});
          },
          onCaption: (result) => {
            dispatch(DataChannelActions.setCaption('publish', result.text));
          }
        }),
      });
    }
    else if (publishSettings.publishStart && publishSupervisor.active)
    {
      // Already running (a second effect pass in StrictMode, or a click during a blip).
      dispatch({type:PublishSettingsActions.SET_PUBLISH_FLAGS, publishStart:false});
    }
    if (publishSettings.publishStarting && webrtcPublish.connected)
    {
      dispatch({type:PublishSettingsActions.SET_PUBLISH_FLAGS, publishStarting:false});
    }

    // Gated on the supervisor, not on connected: a session waiting to reconnect is not
    // connected and still has to be stoppable.
    if (publishSettings.publishStop && !publishSettings.publishStopping)
    {
      if (publishSupervisor.active) {
        dispatch({type:PublishSettingsActions.SET_PUBLISH_FLAGS, publishStop:false, publishStopping:true});
        // Closes whatever attempt is current (the WHIP DELETE included) and cancels any wait.
        publishSupervisor.stop();
        dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_RECONNECTING, reconnecting:null});
        dispatch({type:PublishSettingsActions.SET_PUBLISH_FLAGS, publishStarting:false});
        dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_PEERCONNECTION, peerConnection:undefined});
        dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_WEBSOCKET, websocket:undefined});
        dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_CONNECTED, connected:false});
        dispatch(DataChannelActions.resetDataChannel('publish'));
      } else {
        dispatch({type:PublishSettingsActions.SET_PUBLISH_FLAGS, publishStop:false});
      }
    }
    if (publishSettings.publishStopping && !webrtcPublish.connected)
    {
      dispatch({type:PublishSettingsActions.SET_PUBLISH_FLAGS, publishStopping:false});
    }


  }, [dispatch,store,publishSettings,webrtcPublish]);

  // Handle Mic and Cam Track Changes
  const { audioTrack, videoTrack } = useSelector ((state) => state.publishSettings);
  const {
    peerConnection,
    peerConnectionAudioSender: audioSender,
    peerConnectionVideoSender: videoSender,
  } = useSelector((state) => state.webrtcPublish);

  useEffect(() => {
    if (peerConnection != null) {
      replaceAudioTrack(audioTrack, audioSender, peerConnection, {
        onSetSenders: (senders) => {
          dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_PEERCONNECTION_AUDIO_SENDER,peerConnectionAudioSender:senders.audioSender});
        }
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[dispatch,audioTrack]);

  useEffect(() => {
    if (peerConnection != null) {
      replaceVideoTrack(videoTrack, videoSender, peerConnection, {
        onSetSenders: (senders) => {
          dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_PEERCONNECTION_VIDEO_SENDER,peerConnectionVideoSender:senders.videoSender});
        }
      });
    }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[dispatch,videoTrack]);

  // The sender limits: bitrate caps, simulcast scale down and bitrate per rendition, and
  // what to give up when bandwidth is short. All of them can change mid-stream.
  //
  // startPublish applies them once as soon as the senders exist, so a stream starts capped;
  // these effects cover every change after that. Both go through the per-sender queue in
  // SenderParameters.js, so two setParameters never overlap on one sender. They depend on
  // the sender objects themselves: replaceVideoTrack and replaceAudioTrack add a new sender
  // when there was none, and that one needs the limits too. Re-runs on connect, so values
  // edited while connecting are picked up. An invalid cap is passed as undefined, which
  // leaves the running value alone while the field shows its error.
  const {
    useSimulcast,
    simulcastRenditions,
    videoMaxBitrateKbps,
    audioMaxBitrateKbps,
    degradationPreference,
  } = publishSettings;
  const connected = webrtcPublish.connected;

  useEffect(() => {
    if (!connected || videoSender == null) return;

    applyVideoSenderParameters(videoSender, videoSenderSettings({
      useSimulcast, simulcastRenditions, videoMaxBitrateKbps, degradationPreference,
    })).catch((error) => {
      dispatch({type:ErrorsActions.SET_ERROR_MESSAGE, message:'Could not apply the video limits: ' + error.message});
    });
  },[dispatch,connected,videoSender,useSimulcast,simulcastRenditions,videoMaxBitrateKbps,degradationPreference]);

  useEffect(() => {
    if (!connected || audioSender == null) return;

    applyAudioSenderParameters(audioSender, audioSenderSettings({ audioMaxBitrateKbps })).catch((error) => {
      dispatch({type:ErrorsActions.SET_ERROR_MESSAGE, message:'Could not apply the audio limit: ' + error.message});
    });
  },[dispatch,connected,audioSender,audioMaxBitrateKbps]);

  return <></>;
}

export default Publisher;
